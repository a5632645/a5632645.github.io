import numpy as np
import matplotlib.pyplot as plt
import scipy
import scipy.signal
import random

from scipy.io import wavfile
fs, x = wavfile.read('C:/Users/Kawai/Desktop/io/burg/o.wav')

# 分析
p = 35
lern = 0.1
w = np.zeros(p)
latch = np.zeros(p)
resc = np.zeros(len(x))

# 合成
ww = np.zeros(p)
iir_latch = np.zeros(p)
synthsis = np.zeros(len(x))
saw = np.zeros(len(x))
pitch_up = np.array([110, 165, 220, 275, 330])
phase_inc = pitch_up / fs
phase = np.zeros(len(pitch_up))
g = 0.0
for i in range(len(x)):
    phase += phase_inc
    phase = np.mod(phase, 1.0)
    saw[i] = np.sum(phase * 2 - 1)

for i in range(len(x)):
    pred = np.dot(w, latch)
    resc[i] = x[i] - pred
    w = w + lern * resc[i] * latch
    latch[1:] = latch[:-1]
    latch[0] = x[i]

    # iir
    gg = np.sqrt(resc[i] ** 2 + 1e-10)
    g = g * 0.99 + gg * 0.01
    ww = ww * 0.997 + w * 0.003
    synthsis[i] = np.dot(ww, iir_latch) + saw[i] * g
    iir_latch[1:] = iir_latch[:-1]
    iir_latch[0] = synthsis[i]

resc = resc / np.max(resc)
synthsis = synthsis / np.max(synthsis)

print(w)
wavfile.write('C:/Users/Kawai/Desktop/io/burg/lms_resc.wav', rate=fs, data=resc)
wavfile.write('C:/Users/Kawai/Desktop/io/burg/lms_vocoder.wav', rate=fs, data=synthsis)
