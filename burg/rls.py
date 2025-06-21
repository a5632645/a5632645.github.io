import numpy as np
import matplotlib.pyplot as plt
import scipy
import scipy.signal
import random

from scipy.io import wavfile
fs, x = wavfile.read('C:/Users/Kawai/Desktop/io/burg/o.wav')

# 分析
p = 35
w = np.zeros(p)
latch = np.zeros(p)
p = np.zeros((p, p))
resc = np.zeros(len(x))
lamda = 0.95

for i in range(len(x)):
    k = (p * latch) / (lamda + latch * p * latch)
    pred = np.dot(w, latch)
    resc[i] = x[i] - pred
    w = w + k * resc[i]
    p = (p - k * latch * p) / lamda
    latch[1:] = latch[:-1]
    latch[0] = x[i]

resc = resc / np.max(resc)

print(w)
# wavfile.write('C:/Users/Kawai/Desktop/io/burg/lms_resc.wav', rate=fs, data=resc)
# wavfile.write('C:/Users/Kawai/Desktop/io/burg/lms_vocoder.wav', rate=fs, data=synthsis)
