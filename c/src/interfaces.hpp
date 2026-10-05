#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>
#include "llama.h"
#include <nlohmann/json.hpp>

struct GenerationResult {
    std::string text;
    std::string completion_reason = "length";
    int prompt_tokens = 0;
    int reused_tokens = 0;
    int prefilled_tokens = 0;
    int generated_tokens = 0;
    int evaluated_tokens = 0;
};

class Inference {
public:
    explicit Inference(llama_model* loaded_model);
    Inference(const Inference&) = delete;
    GenerationResult generate(const std::string& prompt, int max_tokens,
                              float temperature, std::uint32_t seed);
private:
    llama_model* model;
    std::unique_ptr<llama_context, decltype(&llama_free)>
        context{nullptr, llama_free};
    std::vector<llama_token> evaluated;
};

nlohmann::json handle_record(const std::string& line, Inference* inference);
