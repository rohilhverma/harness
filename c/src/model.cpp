#include "interfaces.hpp"
#include "llama.h"
#include <algorithm>
#include <chrono>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <vector>

Inference::Inference(llama_model* loaded_model) : model(loaded_model) {
    auto context_params = llama_context_default_params();
    context_params.n_ctx = 16384;
    context.reset(llama_init_from_model(model, context_params));
    if (!context) {
        throw std::runtime_error("Failed to create context.");
    }
}

GenerationResult Inference::generate(const std::string& prompt, int max_tokens,
                                    float temperature, std::uint32_t seed) try {
    const auto* vocab = llama_model_get_vocab(model);
    const int required = llama_tokenize(
        vocab, prompt.data(), static_cast<int>(prompt.size()),
        nullptr, 0, false, true);
    const int n_prompt = -required;
    if (n_prompt <= 0) {
        throw std::invalid_argument("Prompt produced no tokens.");
    }

    std::cerr << "[sidecar] context capacity=" << llama_n_ctx_seq(context.get())
              << " batch=" << llama_n_batch(context.get())
              << " ubatch=" << llama_n_ubatch(context.get())
              << " prompt_tokens=" << n_prompt << '\n';
    if (static_cast<std::int64_t>(n_prompt) + max_tokens - 1 >
        llama_n_ctx_seq(context.get())) {
        throw std::invalid_argument("Prompt and max_tokens exceed context capacity.");
    }

    std::vector<llama_token> prompt_tokens(n_prompt);
    llama_tokenize(vocab, prompt.data(), static_cast<int>(prompt.size()),
                   prompt_tokens.data(), n_prompt, false, true);

    int reused = 0;
    while (reused < n_prompt && reused < static_cast<int>(evaluated.size()) &&
           prompt_tokens[reused] == evaluated[reused]) {
        ++reused;
    }
    // Re-evaluate the final prompt token when every prompt token matches.
    reused = std::min(reused, n_prompt - 1);
    const auto memory = llama_get_memory(context.get());
    if (!llama_memory_seq_rm(memory, 0, reused, -1)) {
        std::cerr << "[sidecar] prefix removal failed; resetting cache\n";
        llama_memory_clear(memory, true);
        reused = 0;
    }
    std::cerr << "[sidecar] prefix cached=" << evaluated.size()
              << " reused=" << reused
              << " prefill=" << n_prompt - reused << '\n';
    evaluated.resize(reused);

    std::unique_ptr<llama_sampler, decltype(&llama_sampler_free)> sampler(
        llama_sampler_chain_init(llama_sampler_chain_default_params()),
        llama_sampler_free);
    if (temperature == 0) {
        llama_sampler_chain_add(sampler.get(), llama_sampler_init_greedy());
    } else {
        llama_sampler_chain_add(sampler.get(), llama_sampler_init_temp(temperature));
        llama_sampler_chain_add(sampler.get(), llama_sampler_init_dist(seed));
    }

    const int batch_size = std::min(n_prompt - reused,
        static_cast<int>(llama_n_batch(context.get())));
    std::vector<llama_pos> positions(batch_size);
    std::vector<std::int8_t> request_logits(batch_size);
    // Sequence 0 is implicit; the vectors own the explicit batch metadata.
    llama_batch batch{};
    batch.pos = positions.data();
    batch.logits = request_logits.data();

    GenerationResult result;
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
        evaluated.insert(evaluated.end(), prompt_tokens.begin() + offset,
                         prompt_tokens.begin() + offset + batch.n_tokens);
        result.prefilled_tokens += batch.n_tokens;
        result.evaluated_tokens += batch.n_tokens;
    }

    const auto generation_started = std::chrono::steady_clock::now();
    std::cerr << "[sidecar] prefill ms="
              << std::chrono::duration_cast<std::chrono::milliseconds>(
                  generation_started - prefill_started).count() << '\n';
    llama_pos next_position = n_prompt;
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
        positions[0] = next_position;
        request_logits[0] = 1;
        const int status = llama_decode(context.get(), batch);
        if (status != 0) {
            throw std::runtime_error("Decode failed at position " + std::to_string(next_position) + ": " + std::to_string(status));
        }
        evaluated.push_back(token);
        ++next_position;
        ++result.evaluated_tokens;
    }
    std::cerr << "[sidecar] generation ms="
              << std::chrono::duration_cast<std::chrono::milliseconds>(
                  std::chrono::steady_clock::now() - generation_started).count()
              << " reused=" << result.reused_tokens
              << " prefilled=" << result.prefilled_tokens
              << " generated=" << result.generated_tokens
              << " evaluated=" << result.evaluated_tokens
              << " reason=" << result.completion_reason << '\n';
    return result;
} catch (...) {
    std::cerr << "[sidecar] generation failed; clearing cached state\n";
    llama_memory_clear(llama_get_memory(context.get()), true);
    evaluated.clear();
    throw;
}
