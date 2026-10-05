#include <chrono>
#include <cstddef>
#include <exception>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include "llama.h"
#include "interfaces.hpp"

using Json = nlohmann::json;

struct LlamaBackend {
    LlamaBackend() { llama_backend_init(); }
    ~LlamaBackend() { llama_backend_free(); }
};

int main(int argc, char** argv) {
    try {
        std::ios::sync_with_stdio(false);
        std::cin.tie(nullptr);
        constexpr std::size_t max_record_bytes = 1024 * 1024;

        if (argc > 2) {
            throw std::runtime_error("Usage: harness-sidecar [model.gguf]");
        }

        LlamaBackend backend;
        std::unique_ptr<llama_model, decltype(&llama_model_free)>
            model(nullptr, llama_model_free);
        std::unique_ptr<Inference> inference;

        if (argc == 2) {
            const auto load_started = std::chrono::steady_clock::now();
            auto model_params = llama_model_default_params();
            model_params.n_gpu_layers = 99;
            std::cerr << "[sidecar] loading model=" << argv[1]
                      << " gpu_layers=" << model_params.n_gpu_layers << '\n';
            model.reset(llama_model_load_from_file(argv[1], model_params));
            if (!model) {
                throw std::runtime_error("Failed to load model.");
            }
            std::cerr << "[sidecar] model loaded ms="
                      << std::chrono::duration_cast<std::chrono::milliseconds>(
                          std::chrono::steady_clock::now() - load_started).count() << '\n';
        }
        if (model) {
            inference = std::make_unique<Inference>(model.get());
        }
        std::cerr << "[sidecar] ready model_loaded=" << static_cast<bool>(model) << '\n';

        while (true) {
            std::string line;
            bool oversized = false;
            char ch;

            while (std::cin.get(ch) && ch != '\n') {
                if (line.size() < max_record_bytes) {
                    line.push_back(ch);
                } else {
                    oversized = true;
                }
            }

            if (std::cin.bad() || (std::cin.fail() && !std::cin.eof())) {
                throw std::runtime_error("Failed to read stdin.");
            }
            if (std::cin.eof() && line.empty() && !oversized) {
                break;
            }

            const auto request_started = std::chrono::steady_clock::now();
            const Json response = oversized
                ? Json{
                    {"v", 1}, {"id", nullptr}, {"ok", false},
                    {"error", {
                        {"code", "invalid_request"},
                        {"message", "Request exceeds 1 MiB."}
                    }}
                }
                : handle_record(line, inference.get());

            std::cerr << "[sidecar] response id=" << response["id"].dump()
                      << " ok=" << response["ok"] << " ms="
                      << std::chrono::duration_cast<std::chrono::milliseconds>(
                          std::chrono::steady_clock::now() - request_started).count();
            if (!response["ok"].get<bool>()) {
                std::cerr << " error=" << response["error"].dump();
            }
            std::cerr << '\n';

            if (!(std::cout << response.dump(-1, ' ', false, Json::error_handler_t::replace) << '\n' << std::flush)) {
                throw std::runtime_error("Failed to write stdout.");
            }
        }
 
        std::cerr << "[sidecar] stdin EOF; shutting down\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "[sidecar] fatal: " << error.what() << '\n';
        return 1;
    }

    

}
