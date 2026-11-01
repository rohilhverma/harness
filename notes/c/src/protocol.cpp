#include "interfaces.hpp"
#include <cmath>
#include <iostream>
#include <limits>
#include <stdexcept>

using Json = nlohmann::json;

// A prompt is a nonempty array of {text, special} segments.
static bool read_prompt(const Json& value, std::vector<PromptSegment>& prompt) {
    if (!value.is_array() || value.empty()) {
        return false;
    }
    for (const auto& item : value) {
        if (!item.is_object() || item.size() != 2 ||
            !item.contains("text") || !item["text"].is_string() ||
            !item.contains("special") || !item["special"].is_boolean()) {
            return false;
        }
        prompt.push_back({item["text"].get<std::string>(), item["special"].get<bool>()});
    }
    return true;
}

Json handle_record(const std::string& line, Inference* inference) {
    const auto request = Json::parse(line, nullptr, false);
    const bool valid_json =
        !request.is_discarded() && line.find('\0') == std::string::npos;
    Json response = {{"v", 1}, {"id", nullptr}, {"ok", false}};

    if (valid_json && request.is_object() &&
        request.contains("id") && request["id"].is_string() &&
        request["id"] != "") {
        response["id"] = request["id"];
    }

    if (line.find_first_not_of(" \t\r") == std::string::npos) {
        response["error"] = {
            {"code", "invalid_request"}, {"message", "Request is empty."}
        };
    } else if (!valid_json) {
        response["error"] = {
            {"code", "invalid_json"},
            {"message", "Request is not valid JSON."}
        };
    } else if (!request.is_object() || !response["id"].is_string() ||
               !request.contains("v") || !request["v"].is_number_integer() ||
               !request.contains("method") || !request["method"].is_string() ||
               request["method"] == "" ||
               !request.contains("params") || !request["params"].is_object()) {
        response["error"] = {
            {"code", "invalid_request"},
            {"message", "Expected integer v, nonempty string id and method, and object params."}
        };
    } else if (request["v"] != 1) {
        response["error"] = {
            {"code", "unsupported_version"},
            {"message", "Unsupported protocol version."}
        };
    } else if (request["method"] == "ping") {
        response["ok"] = true;
        response["result"] = {{"status", "ready"}};
    } else if (request["method"] == "prepare") {
        const auto& params = request["params"];
        std::vector<PromptSegment> prompt;
        if (params.size() != 1 || !params.contains("prompt") || !read_prompt(params["prompt"], prompt)) {
            response["error"] = {
                {"code", "invalid_request"},
                {"message", "Expected only a prompt: a nonempty array of {text, special} segments."}
            };
        } else if (!inference) {
            response["error"] = {
                {"code", "model_not_loaded"}, {"message", "No model is loaded."}
            };
        } else {
            try {
                const auto result = inference->prepare(prompt);
                response["result"] = {
                    {"prompt_tokens", result.prompt_tokens},
                    {"reused_tokens", result.reused_tokens},
                    {"prefilled_tokens", result.prefilled_tokens}
                };
                response["ok"] = true;
            } catch (const std::invalid_argument& error) {
                response["error"] = {
                    {"code", "invalid_request"}, {"message", error.what()}
                };
            } catch (const std::exception& error) {
                response["error"] = {
                    {"code", "internal_error"}, {"message", error.what()}
                };
            }
        }
    } else if (request["method"] == "release") {
        const auto& params = request["params"];
        if (params.size() != 1 || !params.contains("sequence") ||
            !params["sequence"].is_number_integer() ||
            params["sequence"] < 0 || params["sequence"] > 1) {
            response["error"] = {
                {"code", "invalid_request"}, {"message", "Expected only sequence 0 or 1."}
            };
        } else if (!inference) {
            response["error"] = {
                {"code", "model_not_loaded"}, {"message", "No model is loaded."}
            };
        } else {
            response["result"] = {
                {"released_tokens", inference->release(params["sequence"].get<int>())}
            };
            response["ok"] = true;
        }
    } else if (request["method"] != "generate") {
        response["error"] = {
            {"code", "unknown_method"}, {"message", "Unknown method."}
        };
    } else {
        const auto& params = request["params"];
        std::vector<PromptSegment> prompt;
        bool known_params = true;
        for (const auto& item : params.items()) {
            known_params = known_params &&
                (item.key() == "prompt" || item.key() == "max_tokens" ||
                 item.key() == "temperature" || item.key() == "seed" ||
                 item.key() == "sequence" || item.key() == "grammar" || item.key() == "triggers");
        }
        // A grammar comes with its nonempty list of trigger patterns.
        Grammar grammar;
        bool valid_grammar = params.contains("grammar") == params.contains("triggers");
        if (valid_grammar && params.contains("grammar")) {
            valid_grammar = params["grammar"].is_string() && !params["grammar"].get<std::string>().empty() &&
                params["triggers"].is_array() && !params["triggers"].empty();
            if (valid_grammar) {
                grammar.text = params["grammar"].get<std::string>();
                for (const auto& trigger : params["triggers"]) {
                    if (!trigger.is_string() || trigger.get<std::string>().empty()) {
                        valid_grammar = false;
                        break;
                    }
                    grammar.triggers.push_back(trigger.get<std::string>());
                }
            }
        }
        if (!known_params || !valid_grammar ||
            !params.contains("prompt") || !read_prompt(params["prompt"], prompt) ||
            !params.contains("max_tokens") || !params["max_tokens"].is_number_integer() ||
            params["max_tokens"] < 1 ||
            params["max_tokens"] > std::numeric_limits<int>::max() ||
            (params.contains("temperature") &&
             (!params["temperature"].is_number() ||
              params["temperature"] < 0 || params["temperature"] > 2 ||
              !std::isfinite(params["temperature"].get<float>()))) ||
            (params.contains("seed") &&
             (!params["seed"].is_number_integer() || params["seed"] < 0 ||
              params["seed"] >= std::numeric_limits<std::uint32_t>::max())) ||
            (params.contains("sequence") &&
             (!params["sequence"].is_number_integer() ||
              params["sequence"] < 0 || params["sequence"] > 1))) {
            response["error"] = {
                {"code", "invalid_request"},
                {"message", "Expected a prompt of {text, special} segments, positive 32-bit max_tokens, "
                            "optional temperature (0..2), optional seed (0..4294967294), "
                            "optional sequence (0 or 1), and an optional grammar string with a "
                            "nonempty triggers array of pattern strings."}
            };
        } else if (!inference) {
            response["error"] = {
                {"code", "model_not_loaded"}, {"message", "No model is loaded."}
            };
        } else {
            try {
                std::cerr << "[sidecar] generate id=" << response["id"].dump()
                          << " max_tokens=" << params["max_tokens"]
                          << " temperature=" << params.value("temperature", 0.2f)
                          << " seed=" << params.value("seed", std::numeric_limits<std::uint32_t>::max())
                          << " sequence=" << params.value("sequence", 0)
                          << " grammar=" << (grammar.text.empty() ? "none" : "lazy")
                          << '\n';
                const auto result = inference->generate(
                    prompt,
                    params["max_tokens"].get<int>(),
                    params.value("temperature", 0.2f),
                    params.value("seed", std::numeric_limits<std::uint32_t>::max()),
                    params.value("sequence", 0),
                    grammar);
                response["result"] = {
                    {"text", result.text},
                    {"completion_reason", result.completion_reason},
                    {"prompt_tokens", result.prompt_tokens},
                    {"reused_tokens", result.reused_tokens},
                    {"prefilled_tokens", result.prefilled_tokens},
                    {"generated_tokens", result.generated_tokens},
                    {"evaluated_tokens", result.evaluated_tokens}
                };
                response["ok"] = true;
            } catch (const std::invalid_argument& error) {
                response["error"] = {
                    {"code", "invalid_request"}, {"message", error.what()}
                };
            } catch (const std::exception& error) {
                response["error"] = {
                    {"code", "internal_error"}, {"message", error.what()}
                };
            }
        }
    }

    return response;
}
