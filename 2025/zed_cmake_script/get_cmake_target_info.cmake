# 获取顶层源目录的所有构建系统目标
# get_property(ALL_TARGETS DIRECTORY ${CMAKE_SOURCE_DIR} PROPERTY BUILDSYSTEM_TARGETS)
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
        set(TARGET_OUTPUT_NAME "${TARGET_NAME}")

        # 3. 获取运行时的输出目录
        get_target_property(OUTPUT_DIR ${TARGET} RUNTIME_OUTPUT_DIRECTORY)

        # # 4. 构造最终的二进制路径
        # if(NOT OUTPUT_DIR)
        #     set(OUTPUT_DIR "${CMAKE_BINARY_DIR}")
        # endif()

        # A. 使用 RUNTIME_OUTPUT_DIRECTORY (如果设置了)
        # if(OUTPUT_DIR)
        # 使用 OS 路径分隔符连接目录和文件名
        set(TARGET_FILE "${OUTPUT_DIR}/${TARGET_OUTPUT_NAME}")
        # else()
        # B. 回退到 CMAKE_BINARY_DIR
        # set(TARGET_FILE "${CMAKE_BINARY_DIR}/${TARGET_OUTPUT_NAME}")
        # endif()

        # Windows/MinGW 的常见问题：需要手动添加 .exe
        # if(WIN32 AND NOT TARGET_FILE MATCHES "\\.exe$")
        # set(TARGET_FILE "${TARGET_FILE}.exe")
        # endif()

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
