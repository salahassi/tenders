#!/usr/bin/env node
// Offline files only. This tool has no provider activation/execution operation.
import { readFile } from "node:fs/promises";
import { CORPUS_SHA256, RETRIEVAL_SHA256, loadReserve, schedule, scoreReserve } from "./reserve.mjs";
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
try {
  const [command, ...files] = process.argv.slice(2), { corpus, retrieval } = await loadReserve();
  let result;
  if (command === "check" && files.length === 0) {
    result = { corpus_sha256: CORPUS_SHA256, retrieval_sha256: RETRIEVAL_SHA256, cases: corpus.cases.length, task_count: new Set(corpus.cases.map((row) => row.task)).size, scheduled_per_model: corpus.scheduled_per_model, retrieval_cases: retrieval.cases.length, prospective_retrieval_cells: retrieval.cases.reduce((sum, row) => sum + row.modes.length, 0), provider_calls: 0, retrieval_executions: 0, actual_outputs_scored: 0, activation: "not_requested", private_holdout: false };
  } else if (command === "schedule" && files.length === 1) {
    result = schedule(corpus, await readJson(files[0]));
  } else if (command === "score" && files.length === 3) {
    const [lock, observations, judgments] = await Promise.all(files.map(readJson));
    result = scoreReserve(corpus, lock, observations, judgments);
  } else {
    throw new Error("Usage: reserve-cli.mjs check | schedule LOCK.json | score LOCK.json OBSERVATIONS.json JUDGMENTS.json; files only, never provider calls");
  }
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "RESERVE_CHECK_FAILED"}\n`);
  process.exitCode = 1;
}
