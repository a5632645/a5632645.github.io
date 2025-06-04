import numpy as np
import matplotlib.pyplot as plt
import scipy
import scipy.signal

from scipy.io import wavfile
_, x = wavfile.read('C:/Users/Kawai/Desktop/io/burg/o.wav')
x = scipy.signal.lfilter([1, -0.7, 0.3], [1, -1.4, 0.49], x)
p = 15
lattice_k = np.zeros(p)
eb_latch = np.zeros(p)
eb_out = np.zeros(p + 1)
ef_out = np.zeros(p + 1)
ef_out_latch = np.zeros(p + 1)
ebsum = np.zeros(p)
efsum = np.zeros(p)
resc = np.zeros(len(x))

# iir
x_iir = np.zeros(p + 1)
l_iir = np.zeros(p + 1)
iir_out = np.zeros(len(x))
test_rec = np.zeros(len(x))
freq = 55
fs = 48000
phase = 0
phase_inc = freq / fs
for i in range(len(x)):
    test_rec[i] = phase * 2 - 1
    phase += phase_inc
    if phase >= 1.0:
        phase -= 1.0

for i in range(len(x)):
    # fir processing
    ef_out[0] = x[i]
    eb_out[0] = x[i]
    for j in range(p):
        up = ef_out[j] * ef_out_latch[j]
        down = ef_out[j] * ef_out[j] + ef_out_latch[j] * ef_out_latch[j]
        efsum[j] = 0.99 * efsum[j] + up
        ebsum[j] = 0.99 * ebsum[j] + down
        if ebsum[j] == 0.0:
            ebsum[j] = 1.0
        lattice_k[j] = -2 * efsum[j] / ebsum[j]
        if abs(lattice_k[j] > 1.0):
            raise RuntimeError('error unstable filter')
        ef_out[j + 1] = ef_out[j] + lattice_k[j] * eb_latch[j]
        eb_out[j + 1] = eb_latch[j] + lattice_k[j] * ef_out[j]
        eb_latch[j] = eb_out[j]
        ef_out_latch[j] = eb_out[j]
    resc[i] = ef_out[-1]

    # iir processing
    x_iir[0] = test_rec[i]
    for j in range(p):
        x_iir[j + 1] = x_iir[j] - lattice_k[p - j - 1] * l_iir[j + 1]
    for j in range(p):
        l_iir[j] = l_iir[j + 1] + lattice_k[p - j - 1] * x_iir[j + 1]
    l_iir[p] = x_iir[-1]
    iir_out[i] = x_iir[-1]

print(lattice_k)
wavfile.write('C:/Users/Kawai/Desktop/io/burg/hello_resc.wav', rate=48000, data=resc)
wavfile.write('C:/Users/Kawai/Desktop/io/burg/hello_iir.wav', rate=48000, data=iir_out)
