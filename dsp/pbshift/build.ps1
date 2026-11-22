param(
    [Parameter(Mandatory)]
    [string]$PbshiftSource
)

$ErrorActionPreference = 'Stop'
$source = (Resolve-Path -LiteralPath $PbshiftSource).Path
$pffft = Join-Path $source 'third_party/pffft'
$linear = Join-Path $source 'third_party/signalsmith-linear'
$build = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid())
New-Item -ItemType Directory -Path $build | Out-Null

foreach ($name in @('pffft', 'pffft_common')) {
    & emcc -O3 -msimd128 -DPFFFT_STATIC_DEFINE "-I$pffft/include/pffft" `
        -c "$pffft/src/$name.c" -o "$build/$name.o"
    if ($LASTEXITCODE -ne 0) { throw "Failed to compile $name" }
}

$exports = '_pb_input,_pb_output,_pb_configure,_pb_reset,_pb_pitch,_pb_formants,_pb_feed,_pb_finish,_pb_read'
& em++ -std=c++17 -O3 -msimd128 -DPFFFT_STATIC_DEFINE `
    "-I$source/include" "-I$linear" "-I$pffft/include/pffft" `
    "$source/src/pb_engine.cpp" "$PSScriptRoot/pbshift_bridge.cpp" `
    "$build/pffft.o" "$build/pffft_common.o" `
    --no-entry -sSTANDALONE_WASM -sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=33554432 `
    -sSTACK_SIZE=1048576 "-sEXPORTED_FUNCTIONS=$exports" -o "$PSScriptRoot/pbshift.wasm"
if ($LASTEXITCODE -ne 0) { throw 'Failed to build pbshift.wasm' }
