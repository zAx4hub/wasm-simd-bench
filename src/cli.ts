#!/usr/bin/env node
import { Command } from "commander";
import fs from "fs";
import { run, demo, inspect } from "./engine.js";

const program = new Command();
program.name("wasm-simd-bench").description("WASM SIMD microbench harness").version("0.1.0");
program.command("demo").description("Run built-in demo").action(() => console.log(JSON.stringify(demo(), null, 2)));
program
  .command("run")
  .argument("[file]", "JSON input")
  .action((file?: string) => {
    const raw = file ? fs.readFileSync(file, "utf8") : "{}";
    console.log(JSON.stringify(run(JSON.parse(raw)), null, 2));
  });
program.command("inspect").action(() => console.log(JSON.stringify(inspect(), null, 2)));
program.parse();
