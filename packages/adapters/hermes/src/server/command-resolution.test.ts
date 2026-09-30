import os from "node:os";
import path from "node:path";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { expect, test } from "vitest";

import { HERMES_CLI } from "../shared/constants.js";
import {
  execute,
  extractHermesProfileFromArgs,
  resolveHermesCommand,
  resolveHermesConfigPath,
  splitHermesGlobalExtraArgs,
} from "./execute.js";
import { testEnvironment } from "./test.js";

test("resolveHermesCommand prefers hermesCommand over command", () => {
  expect(resolveHermesCommand({ hermesCommand: "hermes_maximus", command: "hermes_backup" }))
    .toBe("hermes_maximus");
});

test("resolveHermesCommand falls back to command before default hermes binary", () => {
  expect(resolveHermesCommand({ command: "hermes_maximus" })).toBe("hermes_maximus");
  expect(resolveHermesCommand({})).toBe(HERMES_CLI);
});

test("splitHermesGlobalExtraArgs places profile args before chat", () => {
  expect(splitHermesGlobalExtraArgs(["-p", "profile-a", "--max-tokens", "2000"]))
    .toEqual({
      preCommandArgs: ["-p", "profile-a"],
      postCommandArgs: ["--max-tokens", "2000"],
    });

  expect(splitHermesGlobalExtraArgs(["--profile", "profile-b"])).toEqual({
    preCommandArgs: ["--profile", "profile-b"],
    postCommandArgs: [],
  });

  expect(splitHermesGlobalExtraArgs(["--profile=profile-c"])).toEqual({
    preCommandArgs: ["--profile=profile-c"],
    postCommandArgs: [],
  });

  expect(splitHermesGlobalExtraArgs(["-p profile-d"])).toEqual({
    preCommandArgs: ["-p", "profile-d"],
    postCommandArgs: [],
  });
});

test("extractHermesProfileFromArgs accepts supported profile argument forms", () => {
  expect(extractHermesProfileFromArgs(["--profile", "research"])).toBe("research");
  expect(extractHermesProfileFromArgs(["-p", "ops"])).toBe("ops");
  expect(extractHermesProfileFromArgs(["--profile=default"])).toBe("default");
  expect(extractHermesProfileFromArgs(["-p=worker"])).toBe("worker");
  expect(extractHermesProfileFromArgs(["--profile studio"])).toBe("studio");
  expect(extractHermesProfileFromArgs(["-p consulting"])).toBe("consulting");
});

test("resolveHermesConfigPath uses Hermes home and selected profile", () => {
  expect(resolveHermesConfigPath({ env: { HERMES_HOME: "/tmp/hermes-home" } }, undefined))
    .toBe(path.join("/tmp/hermes-home", "config.yaml"));
});

test("extractHermesProfileFromArgs uses the last repeated profile arg", () => {
  expect(extractHermesProfileFromArgs(["--profile", "base", "--profile", "research"]))
    .toBe("research");
  expect(extractHermesProfileFromArgs(["--profile=base", "-p=ops", "--profile studio"]))
    .toBe("studio");
});

test("resolveHermesConfigPath uses configured HERMES_HOME and profile args", () => {
  expect(resolveHermesConfigPath({
    env: { HERMES_HOME: { type: "plain", value: "/tmp/hermes-home" } },
  }, ["--profile", "research"])).toBe(
    path.join("/tmp/hermes-home", "profiles", "research", "config.yaml"),
  );
});

test("testEnvironment accepts config.command when hermesCommand is absent", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "hermes-command-resolution-"));
  const cliPath = path.join(tempDir, "fake-hermes");

  try {
    await writeFile(cliPath, "#!/bin/sh\necho fake-hermes 1.2.3\n", "utf8");
    await chmod(cliPath, 0o755);

    const result = await testEnvironment({
      companyId: "company-test",
      adapterType: "hermes_local",
      config: { command: cliPath },
    });

    expect(result.status).not.toBe("fail");
    expect(result.checks.some((check) => check.code === "hermes_cli_not_found")).toBe(false);
    expect(result.checks.some(
      (check) => check.code === "hermes_version" && check.message.includes("fake-hermes 1.2.3"),
    )).toBe(true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

interface FakeHermesOptions {
  authToken?: string;
  hermesConfig?: string;
  hermesProfile?: string;
  inheritedEnv?: Record<string, string | undefined>;
}

async function runExecuteWithFakeHermes(
  config: Record<string, unknown>,
  options: FakeHermesOptions = {},
): Promise<{
  args: string[];
  env: Record<string, string | undefined>;
  resultModel: string | null | undefined;
}> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "hermes-execute-"));
  const cliPath = path.join(tempDir, "fake-hermes");
  const argsPath = path.join(tempDir, "args.txt");
  const envPath = path.join(tempDir, "env.txt");
  const changedEnv = {
    ...Object.fromEntries(Object.keys(options.inheritedEnv ?? {}).map((key) => [key, process.env[key]])),
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    HOMEDRIVE: process.env.HOMEDRIVE,
    HOMEPATH: process.env.HOMEPATH,
  };

  try {
    for (const [key, value] of Object.entries(options.inheritedEnv ?? {})) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    process.env.HOME = tempDir;
    process.env.USERPROFILE = tempDir;
    delete process.env.HOMEDRIVE;
    delete process.env.HOMEPATH;

    if (options.hermesConfig) {
      const configDir = options.hermesProfile
        ? path.join(tempDir, "profiles", options.hermesProfile)
        : tempDir;
      await mkdir(configDir, { recursive: true });
      await writeFile(path.join(configDir, "config.yaml"), options.hermesConfig, "utf8");
    }

    await writeFile(
      cliPath,
      [
        "#!/bin/sh",
        "printf '%s\\n' \"$@\" > \"$HERMES_ARGS_FILE\"",
        "printf 'HERMES_HOME=%s\\n' \"$HERMES_HOME\" > \"$HERMES_ENV_FILE\"",
        "printf 'PAPERCLIP_API_KEY=%s\\n' \"$PAPERCLIP_API_KEY\" >> \"$HERMES_ENV_FILE\"",
        "printf 'IGNORED_VALUE=%s\\n' \"$IGNORED_VALUE\" >> \"$HERMES_ENV_FILE\"",
        "printf 'ok\\n\\nsession_id: session-test\\n'",
      ].join("\n") + "\n",
      "utf8",
    );
    await chmod(cliPath, 0o755);

    const result = await execute({
      runId: "run-test",
      agent: {
        id: "agent-test",
        name: "Hermes Test Agent",
        companyId: "company-test",
        adapterConfig: {},
      },
      config: {
        ...config,
        hermesCommand: cliPath,
        cwd: tempDir,
        env: {
          ...(config.env && typeof config.env === "object" && !Array.isArray(config.env)
            ? config.env
            : {}),
          HERMES_ARGS_FILE: argsPath,
          HERMES_ENV_FILE: envPath,
          ...(options.hermesConfig ? { HERMES_HOME: tempDir } : {}),
        },
      },
      runtime: {},
      onLog: async () => {},
      authToken: options.authToken ?? "run-auth-token",
    } as any);

    const parseLines = async (filePath: string) => Object.fromEntries(
      (await readFile(filePath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => {
          const [key, ...valueParts] = line.split("=");
          return [key, valueParts.join("=")];
        }),
    );

    return {
      args: (await readFile(argsPath, "utf8")).trim().split("\n"),
      env: await parseLines(envPath),
      resultModel: result.model,
    };
  } finally {
    for (const [key, value] of Object.entries(changedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("execute normalizes wrapped env values before spawning Hermes", async () => {
  const { env } = await runExecuteWithFakeHermes({
    env: {
      HERMES_HOME: { type: "plain", value: "/tmp/hermes-home" },
      IGNORED_VALUE: { type: "plain" },
    },
  });

  expect(env.HERMES_HOME).toBe("/tmp/hermes-home");
  expect(env.IGNORED_VALUE).toBe("");
});

test("execute preserves explicit empty env values over inherited values", async () => {
  const { env } = await runExecuteWithFakeHermes(
    {
      env: {
        HERMES_HOME: "",
        IGNORED_VALUE: { type: "plain", value: "" },
      },
    },
    {
      inheritedEnv: {
        HERMES_HOME: "/stale/hermes-home",
        IGNORED_VALUE: "stale-value",
      },
    },
  );

  expect(env.HERMES_HOME).toBe("");
  expect(env.IGNORED_VALUE).toBe("");
});

test("execute ignores malformed env wrappers instead of coercing them", async () => {
  const { env } = await runExecuteWithFakeHermes({
    env: { IGNORED_VALUE: { type: "plain", value: 42 } },
  });

  expect(env.IGNORED_VALUE).toBe("");
});

test("execute uses the run token over configured and inherited API keys", async () => {
  const { env } = await runExecuteWithFakeHermes(
    { env: { PAPERCLIP_API_KEY: { type: "plain", value: "configured-api-key" } } },
    { inheritedEnv: { PAPERCLIP_API_KEY: "stale-inherited-api-key" } },
  );

  expect(env.PAPERCLIP_API_KEY).toBe("run-auth-token");
});

test("execute passes Hermes profile args before chat and leaves command args after chat", async () => {
  const { args } = await runExecuteWithFakeHermes({
    extraArgs: ["-p", "profile-a", "--max-tokens", "2000"],
  });

  expect(args.slice(0, 3)).toEqual(["-p", "profile-a", "chat"]);
  expect(args.slice(-2)).toEqual(["--max-tokens", "2000"]);
});

test("execute omits --model when Hermes model config is auto", async () => {
  const { args, resultModel } = await runExecuteWithFakeHermes({ model: "auto" });

  expect(args).not.toContain("-m");
  expect(args).not.toContain("auto");
  expect(resultModel).toBe("auto");
});

test("execute uses Hermes config model when adapter model is auto", async () => {
  const { args, resultModel } = await runExecuteWithFakeHermes(
    { model: "auto", extraArgs: ["--profile", "research"] },
    {
      hermesProfile: "research",
      hermesConfig: ["model:", "  default: gpt-5.5", "  provider: openai-codex"].join("\n"),
    },
  );

  const modelFlagIndex = args.indexOf("-m");
  expect(modelFlagIndex).toBeGreaterThanOrEqual(0);
  expect(args[modelFlagIndex + 1]).toBe("gpt-5.5");
  expect(resultModel).toBe("gpt-5.5");
});

test("execute lets a selected Hermes profile resolve its own model", async () => {
  const { args, resultModel } = await runExecuteWithFakeHermes(
    { model: "auto", extraArgs: ["--profile", "profile-a"] },
    {
      hermesProfile: "profile-a",
      hermesConfig: ["model:", "  default: gpt-5.5", "  provider: openai-codex"].join("\n"),
    },
  );

  expect(args.slice(0, 3)).toEqual(["--profile", "profile-a", "chat"]);
  expect(args).not.toContain("-m");
  expect(args).not.toContain("gpt-5.5");
  expect(resultModel).toBe("auto");
});

test("execute detects model and provider from selected profile when adapter model is unset", async () => {
  const { args, resultModel } = await runExecuteWithFakeHermes(
    { extraArgs: ["--profile", "research"] },
    {
      hermesProfile: "research",
      hermesConfig: ["model:", "  default: gpt-5.5", "  provider: openai-codex"].join("\n"),
    },
  );

  expect(args).toContain("-m");
  expect(args).toContain("gpt-5.5");
  expect(args).toContain("--provider");
  expect(args).toContain("openai-codex");
  expect(resultModel).toBe("gpt-5.5");
});
