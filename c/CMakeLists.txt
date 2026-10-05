cmake_minimum_required(VERSION 3.24)
project(harness_sidecar LANGUAGES CXX)

include(FetchContent)
FetchContent_Declare(json
    URL https://github.com/nlohmann/json/releases/download/v3.12.0/json.tar.xz
)
FetchContent_MakeAvailable(json)

FetchContent_Declare(llama_cpp
    GIT_REPOSITORY https://github.com/ggml-org/llama.cpp.git
    GIT_TAG 7fe450e19305b828c199d602c23a8337aaa1f03b
)
FetchContent_MakeAvailable(llama_cpp)

add_executable(harness-sidecar src/main.cpp src/protocol.cpp src/model.cpp)
target_compile_features(harness-sidecar PRIVATE cxx_std_20)
set_target_properties(harness-sidecar PROPERTIES CXX_EXTENSIONS OFF)
target_link_libraries(harness-sidecar PRIVATE nlohmann_json::nlohmann_json llama)
