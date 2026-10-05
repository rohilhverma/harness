#include "interfaces.hpp"
#include <cmath>
#include <iostream>
#include <limits>
#include <stdexcept>

using Json = nlohmann::json;

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
    } else if (request["method"] != "generate") {
        response["error"] = {
            {"code", "unknown_method"}, {"message", "Unknown method."}
        };
    } else {
        const auto& params = request["params"];
        bool known_params = true;
        for (const auto& item : params.items()) {
            known_params = known_params &&
                (item.key() == "prompt" || item.key() == "max_tokens" ||
                 item.key() == "temperature" || item.key() == "seed");
        }
        if (!known_params ||
            !params.contains("prompt") || !params["prompt"].is_string() ||
            params["prompt"] == "" ||
            !params.contains("max_tokens") || !params["max_tokens"].is_number_integer() ||
            params["max_tokens"] < 1 ||
            params["max_tokens"] > std::numeric_limits<int>::max() ||
            (params.contains("temperature") &&
             (!params["temperature"].is_number() ||
              params["temperature"] < 0 || params["temperature"] > 2 ||
              !std::isfinite(params["temperature"].get<float>()))) ||
            (params.contains("seed") &&
             (!params["seed"].is_number_integer() || params["seed"] < 0 ||
              params["seed"] >= std::numeric_limits<std::uint32_t>::max()))) {
            response["error"] = {
                {"code", "invalid_request"},
                {"message", "Expected nonempty prompt, positive 32-bit max_tokens, "
                            "optional temperature (0..2), and optional seed (0..4294967294)."}
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
                          << '\n';
                const auto result = inference->generate(
                    params["prompt"].get<std::string>(),
                    params["max_tokens"].get<int>(),
                    params.value("temperature", 0.2f),
                    params.value("seed", std::numeric_limits<std::uint32_t>::max()));
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
