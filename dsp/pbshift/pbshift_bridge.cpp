#include "pbshift/pbshift.h"

namespace {
constexpr int blockSize = 128;
pbshift::Stretcher engine;
float input[2][blockSize];
float output[2][blockSize];
const float* const inputChannels[] = {input[0], input[1]};
float* const outputChannels[] = {output[0], output[1]};
}

extern "C" {
float* pb_input() { return input[0]; }
float* pb_output() { return output[0]; }

int pb_configure(int sampleRate, int mode, int tier) {
    pbshift::Config config;
    config.sampleRate = sampleRate;
    config.mode = static_cast<pbshift::Config::Mode>(mode);
    config.tier = static_cast<pbshift::Config::Tier>(tier);
    engine.configure(config);
    return engine.inputLatency();
}

void pb_reset() { engine.reset(); }
void pb_pitch(double semitones) { engine.setPitchSemitones(semitones); }
void pb_formants(int preserve) { engine.setFormantPreserve(preserve != 0); }
void pb_feed(int frames) { engine.feed(inputChannels, frames); }
void pb_finish() { engine.finish(); }
int pb_read(int frames) { return engine.read(outputChannels, frames); }
}
