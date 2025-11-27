import numpy as np

nk = 10
c = [-0.99775107, 0.9008304, -0.66929331, 0.58646736, -0.64163267, 0.63343736, -0.52581213, 0.52566445, -0.33418013, -0.01417485, 1] # lattice k[n] is 1
f = np.zeros(nk)
g = np.zeros(nk)

f[0] = (1 - c[0] * c[0]) * c[1]
g[0] = c[0] * c[1]
for i in range(1, nk):
    f[i] = (c[i] * c[i] - 1) * c[i + 1] / c[i]
    g[i] = c[i + 1] / c[i]

itf = np.zeros(nk + 1)
itg = np.zeros(nk)
itg_latch = np.zeros(nk)
it = nk+1

# init
itf[-1] = 0
itf[0] = 0
for i in range(1, nk):
    itf[i] = f[i]
for i in range(nk):
    itg[i] = g[i]

# iterating for others
for m in range(it):
    itg_latch[0] = itg[0]
    itg[0] = itg[0] + itf[1]
    for k in range(1, nk):
        itf[k] = (itg[k] + itf[k + 1]) * itf[k] / (itg[k - 1] + itf[k])
        itg_latch[k] = itg[k]
        itg[k] = itg[k] + itf[k + 1] - itf[k]

# get poles
radius = np.zeros(nk // 2)
phase = np.zeros(nk // 2)
for i in range(len(radius)):
    radius_pow2 = abs(itg_latch[2 * i] * itg_latch[2 * i - 1])
    radius[i] = np.sqrt(radius_pow2)
    phase[i] = np.arccos((itg[2 * i - 1] + itg_latch[2 * i]) / 2 / radius[i])

print(radius)
print(phase)
