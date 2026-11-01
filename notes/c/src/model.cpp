#include "interfaces.hpp"
#include "llama.h"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <vector>

Inference::Inference(llama_model* loaded_model) : model(loaded_model) {
    auto context_params = llama_context_default_params();
    context_params.n_ctx = 16384;
    // Two sequences share all 16,384 cells instead of splitting them in half.
    context_params.n_seq_max = 2;
    context_params.kv_unified = true;
    context.reset(llama_init_from_model(model, context_params));
    if (!context) {
        throw std::runtime_error("Failed to create context.");
    }
}

void Inference::forget(int sequence) {
    llama_memory_seq_rm(llama_get_memory(context.get()), sequence, -1, -1);
    evaluated.at(sequence).clear();
}

int Inference::release(int sequence) {
    const int released = static_cast<int>(evaluated.at(sequence).size());
    forget(sequence);
    std::cerr << "[sidecar] released sequence=" << sequence << " tokens=" << released << '\n';
    return released;
}

PreparationResult Inference::prefill(const std::vector<PromptSegment>& prompt, int additional_positions, int sequence) {
    auto& history = evaluated.at(sequence);
    const auto* vocab = llama_model_get_vocab(model);
    // Message text stays plain, so control-token text inside it cannot end a turn.
    std::vector<llama_token> prompt_tokens;
    for (const auto& segment : prompt) {
        const int count = -llama_tokenize(
            vocab, segment.text.data(), static_cast<int>(segment.text.size()),
            nullptr, 0, false, segment.special);
        const auto offset = prompt_tokens.size();
        prompt_tokens.resize(offset + count);
        llama_tokenize(vocab, segment.text.data(), static_cast<int>(segment.text.size()),
                       prompt_tokens.data() + offset, count, false, segment.special);
    }
    const int n_prompt = static_cast<int>(prompt_tokens.size());
    if (n_prompt <= 0) {
        throw std::invalid_argument("Prompt produced no tokens.");
    }

    std::cerr << "[sidecar] context capacity=" << llama_n_ctx_seq(context.get())
              << " batch=" << llama_n_batch(context.get())
              << " ubatch=" << llama_n_ubatch(context.get())
              << " prompt_tokens=" << n_prompt << '\n';
    if (static_cast<std::int64_t>(n_prompt) + additional_positions >
        llama_n_ctx_seq(context.get())) {
        throw std::invalid_argument("Prompt and output allowance exceed context capacity.");
    }
    // The other sequence's cache is dropped only when this request needs its cells.
    const int other = 1 - sequence;
    if (static_cast<std::int64_t>(n_prompt) + additional_positions +
        static_cast<std::int64_t>(evaluated.at(other).size()) > llama_n_ctx(context.get())) {
        std::cerr << "[sidecar] evicting sequence=" << other
                  << " tokens=" << evaluated.at(other).size() << " to make room\n";
        forget(other);
    }

    int reused = 0;
    while (reused < n_prompt && reused < static_cast<int>(history.size()) &&
           prompt_tokens[reused] == history[reused]) {
        ++reused;
    }
    // Re-evaluate the final prompt token when every prompt token matches.
    reused = std::min(reused, n_prompt - 1);
    const auto memory = llama_get_memory(context.get());
    if (!llama_memory_seq_rm(memory, sequence, reused, -1)) {
        std::cerr << "[sidecar] prefix removal failed; resetting sequence\n";
        forget(sequence);
        reused = 0;
    }
    std::cerr << "[sidecar] prefix sequence=" << sequence
              << " cached=" << history.size()
              << " reused=" << reused
              << " prefill=" << n_prompt - reused << '\n';
    history.resize(reused);

    const int batch_size = std::min(n_prompt - reused,
        static_cast<int>(llama_n_batch(context.get())));
    std::vector<llama_pos> positions(batch_size);
    std::vector<std::int8_t> request_logits(batch_size);
    llama_seq_id sequence_id = sequence;
    std::vector<llama_seq_id*> sequence_ids(batch_size, &sequence_id);
    std::vector<std::int32_t> sequence_counts(batch_size, 1);
    // The vectors own the explicit batch metadata; every token belongs to this sequence.
    llama_batch batch{};
    batch.pos = positions.data();
    batch.n_seq_id = sequence_counts.data();
    batch.seq_id = sequence_ids.data();
    batch.logits = request_logits.data();

    PreparationResult result;
    result.prompt_tokens = n_prompt;
    result.reused_tokens = reused;
    const auto prefill_started = std::chrono::steady_clock::now();
    for (int offset = reused; offset < n_prompt; offset += batch.n_tokens) {
        batch.n_tokens = std::min(batch_size, n_prompt - offset);
        batch.token = prompt_tokens.data() + offset;
        for (int i = 0; i < batch.n_tokens; ++i) {
            positions[i] = offset + i;
            request_logits[i] = offset + i == n_prompt - 1;
        }
        const int status = llama_decode(context.get(), batch);
        if (status != 0) {
            throw std::runtime_error("Prefill failed at position " + std::to_string(offset) + ": " + std::to_string(status));
        }
        history.insert(history.end(), prompt_tokens.begin() + offset,
                       prompt_tokens.begin() + offset + batch.n_tokens);
        result.prefilled_tokens += batch.n_tokens;
    }

    std::cerr << "[sidecar] prefill ms="
              << std::chrono::duration_cast<std::chrono::milliseconds>(
                  std::chrono::steady_clock::now() - prefill_started).count() << '\n';
    return result;
}

PreparationResult Inference::prepare(const std::vector<PromptSegment>& prompt) try {
    return prefill(prompt, 0, 0);
} catch (...) {
    std::cerr << "[sidecar] preparation failed; clearing cached state\n";
    forget(0);
    throw;
}

GenerationResult Inference::generate(const std::vector<PromptSegment>& prompt, int max_tokens,
                                    float temperature, std::uint32_t seed, int sequence,
                                    const Grammar& grammar) try {
    const auto prepared = prefill(prompt, max_tokens - 1, sequence);
    GenerationResult result;
    result.prompt_tokens = prepared.prompt_tokens;
    result.reused_tokens = prepared.reused_tokens;
    result.prefilled_tokens = prepared.prefilled_tokens;
    result.evaluated_tokens = prepared.prefilled_tokens;
    const auto* vocab = llama_model_get_vocab(model);
    std::unique_ptr<llama_sampler, decltype(&llama_sampler_free)> sampler(
        llama_sampler_chain_init(llama_sampler_chain_default_params()),
        llama_sampler_free);
    // A reply may end its turn but never start another: control tokens other than end-of-generation
    // ones, such as <|im_start|>, are never sampled.
    std::vector<llama_logit_bias> banned;
    for (llama_token token = 0; token < llama_vocab_n_tokens(vocab); ++token) {
        if ((llama_vocab_get_attr(vocab, token) & LLAMA_TOKEN_ATTR_CONTROL) && !llama_vocab_is_eog(vocab, token)) {
            banned.push_back({token, -INFINITY});
        }
    }
    llama_sampler_chain_add(sampler.get(), llama_sampler_init_logit_bias(
        llama_vocab_n_tokens(vocab), static_cast<int32_t>(banned.size()), banned.data()));
    // The grammar comes next, so the other samplers only see tokens it allows.
    if (!grammar.text.empty()) {
        std::vector<const char*> patterns;
        for (const auto& trigger : grammar.triggers) {
            patterns.push_back(trigger.c_str());
        }
        auto* constrained = llama_sampler_init_grammar_lazy_patterns(
            vocab, grammar.text.c_str(), "root", patterns.data(), patterns.size(), nullptr, 0);
        if (!constrained) {
            throw std::invalid_argument("The grammar could not be parsed.");
        }
        llama_sampler_chain_add(sampler.get(), constrained);
    }
    if (temperature == 0) {
        llama_sampler_chain_add(sampler.get(), llama_sampler_init_greedy());
    } else {
        llama_sampler_chain_add(sampler.get(), llama_sampler_init_temp(temperature));
        llama_sampler_chain_add(sampler.get(), llama_sampler_init_dist(seed));
    }

    llama_pos position = prepared.prompt_tokens;
    std::int8_t request_logits = 1;
    llama_seq_id sequence_id = sequence;
    llama_seq_id* sequence_ids = &sequence_id;
    std::int32_t sequence_count = 1;
    llama_batch batch{};
    batch.pos = &position;
    batch.n_seq_id = &sequence_count;
    batch.seq_id = &sequence_ids;
    batch.logits = &request_logits;
    const auto generation_started = std::chrono::steady_clock::now();
    std::string piece(128, '\0');
    while (result.generated_tokens < max_tokens) {
        llama_token token = llama_sampler_sample(sampler.get(), context.get(), -1);
        ++result.generated_tokens;
        if (llama_vocab_is_eog(vocab, token)) {
            result.completion_reason = "eog";
            break;
        }

        int bytes = llama_token_to_piece(
            vocab, token, piece.data(), static_cast<int>(piece.size()), 0, true);
        if (bytes < 0) {
            piece.resize(-bytes);
            bytes = llama_token_to_piece(
                vocab, token, piece.data(), static_cast<int>(piece.size()), 0, true);
        }
        result.text.append(piece.data(), bytes);
        // Returning the final token does not require evaluating it.
        if (result.generated_tokens == max_tokens) {
            break;
        }

        batch.n_tokens = 1;
        batch.token = &token;

        const int status = llama_decode(context.get(), batch);
        if (status != 0) {
            throw std::runtime_error("Decode failed at position " + std::to_string(position) + ": " + std::to_string(status));
        }
        evaluated.at(sequence).push_back(token);
        ++position;
        ++result.evaluated_tokens;
    }
    std::cerr << "[sidecar] generation ms="
              << std::chrono::duration_cast<std::chrono::milliseconds>(
                  std::chrono::steady_clock::now() - generation_started).count()
              << " sequence=" << sequence
              << " reused=" << result.reused_tokens
              << " prefilled=" << result.prefilled_tokens
              << " generated=" << result.generated_tokens
              << " evaluated=" << result.evaluated_tokens
              << " reason=" << result.completion_reason << '\n';
    return result;
} catch (...) {
    std::cerr << "[sidecar] generation failed; clearing cached state\n";
    forget(sequence);
    throw;
}
