$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    $exports = @(
        'init', 'process', 'set_pitch_shift', 'set_algorithm',
        'set_cooldown_ms', 'set_full_spectrum', 'reinit', 'reset', 'in_ptr', 'out_ptr', 'in_right_ptr',
        'out_right_ptr', 'env_ptr', 'marks_ptr', 'mark_count', 'col_index', 'total_columns',
        'hop', 'window_size', 'fft_size', 'window_type', 'display_size', 'columns', 'position', 'ratio',
        'latency_samples'
    )
    $flags = @('--target=wasm32', '-msimd128', '-mbulk-memory', '-O3', '-flto', '-DNDEBUG')
    $object = Join-Path ([System.IO.Path]::GetTempPath()) ("pghi-pffft-" + [guid]::NewGuid() + ".o")
    & clang @flags -std=c11 -DPGHI_FREESTANDING -DPFFFT_ENABLE_WASM=1 -c vendor/pffft/pffft.c -o $object
    if ($LASTEXITCODE -ne 0) { throw 'PFFFT compilation failed' }
    $link = $exports | ForEach-Object { "-Wl,--export=$_" }
    & clang++ @flags -std=c++17 -nostdlib -fno-exceptions -fno-rtti "-Wl,--no-entry" `
        "-Wl,--initial-memory=33554432" "-Wl,--max-memory=33554432" "-Wl,--strip-all" @link `
        pghi_shifter.cpp $object -o pghi_shifter.wasm
    if ($LASTEXITCODE -ne 0) { throw 'PGHI linking failed' }
} finally {
    if ($object -and (Test-Path -LiteralPath $object)) { Remove-Item -LiteralPath $object }
    Pop-Location
}
