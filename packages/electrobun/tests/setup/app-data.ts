import { afterEach } from "bun:test";

// The desktop backend publishes its data directory through the environment;
// restore it after every test instead of in each test's cleanup.
const initial = process.env.FURIN_APP_DATA_DIR;

afterEach(() => {
  if (initial === undefined) {
    delete process.env.FURIN_APP_DATA_DIR;
  } else {
    process.env.FURIN_APP_DATA_DIR = initial;
  }
});
