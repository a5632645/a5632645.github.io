# 获取顶层源目录的所有构建系统目标
function(get_all_targets _result _dir)
    # 获取_dir处的所有子文件夹
    get_property(_subdirs DIRECTORY "${_dir}" PROPERTY SUBDIRECTORIES)
    foreach(_subdir IN LISTS _subdirs)
        get_all_targets(${_result} "${_subdir}")
    endforeach()

    # 获取_dir处的所有target
    get_directory_property(_sub_targets DIRECTORY "${_dir}" BUILDSYSTEM_TARGETS)
    foreach(TARGET ${_sub_targets})
        get_target_property(TARGET_TYPE ${TARGET} TYPE)
        if(TARGET_TYPE STREQUAL "EXECUTABLE")
            get_target_property(TARGET_NAME ${TARGET} NAME)

            # Get the runtime output directory.  If not set, use CMAKE_RUNTIME_OUTPUT_DIRECTORY
            get_target_property(OUTPUT_DIR ${TARGET} RUNTIME_OUTPUT_DIRECTORY)
            if(NOT OUTPUT_DIR)
                get_property(OUTPUT_DIR GLOBAL PROPERTY CMAKE_RUNTIME_OUTPUT_DIRECTORY)
                if(NOT OUTPUT_DIR)
                    # If CMAKE_RUNTIME_OUTPUT_DIRECTORY is not set either, default to the build directory
                    file(RELATIVE_PATH RELATIVE_PATH "${CMAKE_SOURCE_DIR}" "${_dir}")
                    set(OUTPUT_DIR "${CMAKE_BINARY_DIR}/${RELATIVE_PATH}")
                endif()
            endif()

            # Construct the full path to the executable
            set(TARGET_EXE_PATH "${OUTPUT_DIR}/${TARGET_NAME}")

            # Create JSON string
            string(REPLACE "\\" "\\\\" TARGET_EXE_PATH_ESCAPED "${TARGET_EXE_PATH}")
            set(TARGET_INFO "{\"name\":\"${TARGET_NAME}\", \"path\":\"${TARGET_EXE_PATH_ESCAPED}\"}")

            # Append the JSON string to the list
            list(APPEND ${_result} ${TARGET_INFO})
        endif()
    endforeach()

    # Set the result in the parent scope as a list
    set(${_result} ${${_result}} PARENT_SCOPE)
endfunction()

# Call the function to get all executable targets
get_all_targets(TARGET_INFO_LIST ${CMAKE_SOURCE_DIR})

# Wrap the list elements in brackets to form a JSON array
set(JSON_OUTPUT "[")
foreach(TARGET_INFO IN LISTS TARGET_INFO_LIST)
    if(NOT JSON_OUTPUT STREQUAL "[")
        string(APPEND JSON_OUTPUT ",")
    endif()
    string(APPEND JSON_OUTPUT ${TARGET_INFO})
endforeach()
string(APPEND JSON_OUTPUT "]")

# Write the JSON to a file
file(WRITE "${CMAKE_BINARY_DIR}/cmake_target_info.json" "${JSON_OUTPUT}")

message(STATUS "Generated cmake_target_info.json in ${CMAKE_BINARY_DIR}")
