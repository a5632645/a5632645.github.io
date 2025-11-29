import json
import os
import subprocess

########################################
# user configurations
# no preset toolchains
c_path = r"C:\Program Files\LLVM\bin\clang.exe"
cxx_path = r"C:\Program Files\LLVM\bin\clang.exe"
# EXECUTABLE;STATIC_LIBRARY
cmake_test_arg = "-DCMAKE_TRY_COMPILE_TARGET_TYPE=EXECUTABLE"

# preset settings
use_preset = True
cmake_presets_file = "CMakePresets.json"
preset_name = "default"

# common settings
build_path = "build"
generator = "Ninja"
# Debug;Release;RelWithDebInfo
build_type = "Debug"
cmake_get_target_script_path = "get_cmake_target_info.cmake"

# debug settings
debug_adapter = "CodeLLDB"
debug_cwd = "."
debug_request = "launch"
build_before_debug = True

########################################
# generated files
zed_tasks_path = ".zed/tasks.json"
zed_debug_path = ".zed/debug.json"
cmake_target_info_file = os.path.join(build_path, "cmake_target_info.json")

########################################
# do not change, help vars
is_cmake_configed = os.path.exists(os.path.join(build_path, "CMakeCache.txt"))
should_use_preset = use_preset and os.path.exists(cmake_presets_file)
cmake_c_complier_arg = f'-DCMAKE_C_COMPILER:FILEPATH="{c_path}"'
cmake_cxx_complier_arg = f'-DCMAKE_CXX_COMPILER:FILEPATH="{cxx_path}"'
cmake_build_type_arg = f"-DCMAKE_BUILD_TYPE={build_type}"

########################################
# run cmake configurate && get cmake target infomations

# cmake configurate command
cmake_config_and_gen_target_args = ""
if should_use_preset:
    cmake_config_and_gen_target_args = f"cmake -DCMAKE_EXPORT_COMPILE_COMMANDS:BOOL=TRUE --preset {preset_name} -S . -B {build_path}"
else:
    cmake_config_and_gen_target_args = f"cmake -DCMAKE_EXPORT_COMPILE_COMMANDS:BOOL=TRUE {cmake_build_type_arg} {cmake_test_arg} {cmake_c_complier_arg} {cmake_cxx_complier_arg} -G {generator} -S . -B {build_path}"

# run cmake
try:
    subprocess.run(
        args=cmake_config_and_gen_target_args,
        check=True,  # Raise an exception if CMake fails
    )
except Exception as e:
    print(f"[ERROR]: Failed to run cmake to generate target info: {e}")
    exit(1)

# get targets
try:
    with open(cmake_target_info_file, "r") as f:
        target_info_list = json.load(f)
except FileNotFoundError:
    print(
        f"[Error]: {cmake_target_info_file} not found.  Make sure your configuration success.  Or adding include({cmake_get_target_script_path}) in your CMakeLists.txt"
    )
    exit(1)

########################################
# generate tasks.json
tasks = []

# configure task
cmake_configure_task = {
    "label": "CMake: Configure",
    "command": "cmake",
    "args": ["-DCMAKE_EXPORT_COMPILE_COMMANDS:BOOL=TRUE"],
    "allow_concurrent_runs": False,
}
if should_use_preset:
    cmake_configure_task["args"] += ["--preset", preset_name]
else:
    cmake_configure_task["args"] += [
        cmake_build_type_arg,
        cmake_test_arg,
        cmake_c_complier_arg,
        cmake_cxx_complier_arg,
        "-G",
        generator,
        "-B",
        build_path,
    ]
tasks.append(cmake_configure_task)

# build all task
cmake_build_task = {
    "label": "CMake: Build all targets",
    "command": "cmake",
    "args": [],
    "allow_concurrent_runs": False,
}
if should_use_preset:
    cmake_build_task["args"] = ["--preset", preset_name]
else:
    cmake_build_task["args"] = ["--build", build_path]
tasks.append(cmake_build_task)

# build target task
for target_info in target_info_list:
    cmake_build_target_task = {
        "label": f"CMake: Build [{target_info['name']}]",
        "command": "cmake",
        "args": [],
        "allow_concurrent_runs": False,
    }
    if should_use_preset:
        cmake_build_target_task["args"] += ["--preset", preset_name]
    else:
        cmake_build_target_task["args"] += ["--build", build_path]
    cmake_build_target_task["args"] += ["--target", target_info["name"]]
    tasks.append(cmake_build_target_task)

# reconfigure task
cmake_clean_reconfigure_task = {
    "label": "CMake: Clear Cache & Reconfigure",
    "command": "cmake",
    "args": [
        "--fresh",  # Clear cache
        "-S",
        ".",  # Source directory (needed with --fresh)
        "-DCMAKE_EXPORT_COMPILE_COMMANDS:BOOL=TRUE",
    ],
    "allow_concurrent_runs": False,
}
if should_use_preset:
    cmake_clean_reconfigure_task["args"] += ["--preset", preset_name, "-B build"]
else:
    cmake_clean_reconfigure_task["args"] += [
        cmake_test_arg,
        cmake_c_complier_arg,
        cmake_cxx_complier_arg,
        "-G",
        generator,
        "-B",
        build_path,
    ]
tasks.append(cmake_clean_reconfigure_task)

# Ensure .zed directory exists
zed_dir = os.path.dirname(zed_tasks_path)
if not os.path.exists(zed_dir):
    os.makedirs(zed_dir)

# Write the JSON data to the file
with open(zed_tasks_path, "w") as f:
    json.dump(tasks, f, indent=2)

########################################
# generate debug.json
debug_configurations = []

for target_info in target_info_list:
    debug_config = {
        "label": f"Debug [{target_info['name']}]",
        "adapter": debug_adapter,
        "cwd": debug_cwd,
        "program": target_info["path"],
        "request": debug_request,
    }
    if build_before_debug:
        debug_config["build"] = {
            "command": "cmake",
            "args": ["--build", build_path, "--target", target_info["name"]],
        }
    debug_configurations.append(debug_config)

# Ensure .zed directory exists
zed_dir = os.path.dirname(zed_debug_path)
if not os.path.exists(zed_dir):
    os.makedirs(zed_dir)

with open(zed_debug_path, "w") as f:
    json.dump(debug_configurations, f, indent=2)
