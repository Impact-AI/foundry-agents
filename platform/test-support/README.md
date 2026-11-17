# @platform/test-support

This package holds what a test in any package needs and no package should write for itself. It is dependency-free, so every package can take it as a dev dependency without a cycle.

- `scoped-env` — `scopedEnv(values)` sets environment variables for a test and hands back their restoration. `undefined` unsets, and the restore reinstates exactly what was there. Every test file runs in one process, so a variable left set or deleted leaks into every file after it.
- `stand-in` — `standIn(real, overrides)` for a `mock.module` factory. The overrides answer while the file that made them runs, and the real exports answer after `release()`. After release a class constructs, a subclass of it builds itself, and a function keeps its own properties, though neither is the real export's identity. An override for a name the real module does not export is refused. `mock.module` registers process-wide and permanently, so a factory that returns a fixed object answers for every later file too.

A fake that stands at an SDK or protocol boundary of one package lives in that package's `./testing` entry, not here.
