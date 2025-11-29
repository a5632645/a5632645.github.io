# get_cmake_target_info.cmake - 修正版

# 获取顶层源目录的所有构建系统目标
# https://stackoverflow.com/questions/60211516/programmatically-get-all-targets-in-a-cmake-project
function(get_all_targets _result _dir)
    get_property(_subdirs DIRECTORY "${_dir}" PROPERTY SUBDIRECTORIES)
    foreach(_subdir IN LISTS _subdirs)
        get_all_targets(${_result} "${_subdir}")
    endforeach()

    get_directory_property(_sub_targets DIRECTORY "${_dir}" BUILDSYSTEM_TARGETS)
    set(${_result} ${${_result}} ${_sub_targets} PARENT_SCOPE)
endfunction()
get_all_targets(ALL_TARGETS ${CMAKE_SOURCE_DIR})

if(NOT ALL_TARGETS)
    message(STATUS "No targets found in ${CMAKE_SOURCE_DIR}. Ensure the project is configured.")
endif()

set(TARGET_INFO_LIST "")

foreach(TARGET ${ALL_TARGETS})
    get_target_property(TARGET_TYPE ${TARGET} TYPE)

    if(TARGET_TYPE STREQUAL "EXECUTABLE")
        # 1. 获取目标名称 (例如 "zed_cmake")
        get_target_property(TARGET_NAME ${TARGET} NAME)

        # 2. 获取最终的输出文件名 (例如 "zed_cmake.exe")
        # OUTPUT_NAME 是目标最终的基名称，通常是 TARGET_NAME。
        # 这里使用 TARGET_NAME 作为文件名，并假定它会包含扩展名。
        # 对于 Windows，我们使用 <TARGET_NAME>.exe 作为回退，因为它在配置时更安全。
        set(TARGET_OUTPUT_NAME "${TARGET_NAME}")

        # 3. 获取运行时的输出目录
        get_target_property(OUTPUT_DIR ${TARGET} RUNTIME_OUTPUT_DIRECTORY)

        # 4. 构造最终的二进制路径

        # 如果 RUNTIME_OUTPUT_DIRECTORY 没有被设置，默认路径通常是 CMAKE_BINARY_DIR
        if(NOT OUTPUT_DIR)
            set(OUTPUT_DIR "${CMAKE_BINARY_DIR}")
        endif()

        # 路径组合: <构建目录>/<目标文件名>
        # 注意: 这里简化了对 Debug/Release 子目录的判断。
        # 完整的跨平台路径需要处理生成器表达式，但对于简单的 Zed/CodeLLDB 配置，
        # 我们使用相对路径回退，或者依赖于构建系统已经设置了 OUTPUT_DIR。

        # 构造路径时，需要考虑到配置类型子目录 (例如 Windows 的 Debug/Release)
        # 这是一个生成器表达式，我们不能直接使用，但我们可以在 Python 脚本中解析它，或者使用一个简化的路径：

        # 我们假设二进制文件在构建目录下的特定子目录中（例如 Debug/Release）
        # 由于我们无法在配置时可靠地确定 Multi-Config 生成器（如 VS）的最终子目录，
        # 最简单且通用性最高的方式是：

        # A. 使用 RUNTIME_OUTPUT_DIRECTORY (如果设置了)
        if(OUTPUT_DIR)
            # 使用 OS 路径分隔符连接目录和文件名
            set(TARGET_FILE "${OUTPUT_DIR}/${TARGET_OUTPUT_NAME}")
        else()
            # B. 回退到 CMAKE_BINARY_DIR
            set(TARGET_FILE "${CMAKE_BINARY_DIR}/${TARGET_OUTPUT_NAME}")
        endif()

        # Windows/MinGW 的常见问题：需要手动添加 .exe
        if(WIN32 AND NOT TARGET_FILE MATCHES "\\.exe$")
            set(TARGET_FILE "${TARGET_FILE}.exe")
        endif()

        # 构造 JSON
        set(TARGET_INFO "{\"name\":\"${TARGET_NAME}\", \"path\":\"${TARGET_FILE}\"}")

        if(NOT TARGET_INFO_LIST STREQUAL "")
            set(TARGET_INFO_LIST "${TARGET_INFO_LIST},${TARGET_INFO}")
        else()
            set(TARGET_INFO_LIST "${TARGET_INFO}")
        endif()
    endif()
endforeach()

# 写入 JSON 文件
set(JSON_OUTPUT "[${TARGET_INFO_LIST}]")
file(WRITE "${CMAKE_BINARY_DIR}/cmake_target_info.json" "${JSON_OUTPUT}")

message(STATUS "Generated cmake_target_info.json in ${CMAKE_BINARY_DIR}")
