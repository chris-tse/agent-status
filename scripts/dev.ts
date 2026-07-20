const services = [
  {
    name: "service",
    cwd: `${import.meta.dir}/../apps/service`,
  },
  {
    name: "dashboard",
    cwd: `${import.meta.dir}/../apps/dashboard`,
  },
] as const;

const children = services.map(({ name, cwd }) => ({
  name,
  process: Bun.spawn(["bun", "run", "dev"], {
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }),
}));

let shuttingDown = false;

async function shutdown(exitCode: number, signal?: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of children) {
    child.process.kill(signal);
  }

  await Promise.all(children.map((child) => child.process.exited));
  process.exit(exitCode);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown(0, signal);
  });
}

for (const child of children) {
  void child.process.exited.then((exitCode) => {
    if (shuttingDown) return;
    console.error(`${child.name} exited with code ${exitCode}; stopping dev servers`);
    void shutdown(exitCode === 0 ? 1 : exitCode);
  });
}
