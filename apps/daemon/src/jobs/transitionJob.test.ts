import { describe, expect, test } from "bun:test";
import type { JobStatus } from "@repo/contracts/JobStatus";
import { Result } from "effect";
import { type JobEvent, transitionJob } from "./transitionJob.ts";

const NOW = "2026-11-07T10:00:00.000Z";

const move = (status: JobStatus, event: JobEvent, attempts = 0) =>
	transitionJob({ status, attempts }, event, NOW);

const retryable = {
	_tag: "FailedRetryably",
	error: "timed out",
	maxAttempts: 3,
} as const;

describe("transitionJob", () => {
	test("pending starts processing", () => {
		expect(move("pending", { _tag: "Started" }, 1)).toEqual(
			Result.succeed({
				status: "processing",
				attempts: 1,
				lastError: null,
				updatedAt: NOW,
				startedAt: NOW,
			}),
		);
	});

	test("processing completes", () => {
		expect(move("processing", { _tag: "Succeeded" })).toEqual(
			Result.succeed({
				status: "completed",
				attempts: 0,
				lastError: null,
				updatedAt: NOW,
				finishedAt: NOW,
			}),
		);
	});

	test("a permanent failure goes straight to failed", () => {
		expect(
			move("processing", { _tag: "FailedPermanently", error: "exit 1" }),
		).toEqual(
			Result.succeed({
				status: "failed",
				attempts: 0,
				lastError: "exit 1",
				updatedAt: NOW,
				finishedAt: NOW,
			}),
		);
	});

	test("a retryable failure returns to pending with one more attempt", () => {
		expect(move("processing", retryable, 1)).toEqual(
			Result.succeed({
				status: "pending",
				attempts: 2,
				lastError: "timed out",
				updatedAt: NOW,
			}),
		);
	});

	test("a retryable failure on the last attempt dead-letters the job", () => {
		expect(move("processing", retryable, 2)).toEqual(
			Result.succeed({
				status: "deadLetter",
				attempts: 3,
				lastError: "timed out",
				updatedAt: NOW,
				finishedAt: NOW,
			}),
		);
	});

	test("pending and processing jobs can be cancelled", () => {
		for (const status of ["pending", "processing"] as const) {
			expect(move(status, { _tag: "Cancelled", reason: "archived" })).toEqual(
				Result.succeed({
					status: "failed",
					attempts: 0,
					lastError: "archived",
					updatedAt: NOW,
					finishedAt: NOW,
				}),
			);
		}
	});

	test("refuses every other move", () => {
		const legal = new Set([
			"pending:Started",
			"processing:Succeeded",
			"processing:FailedPermanently",
			"processing:FailedRetryably",
			"pending:Cancelled",
			"processing:Cancelled",
		]);
		const statuses = [
			"pending",
			"processing",
			"completed",
			"failed",
			"deadLetter",
		] as const;
		const events: ReadonlyArray<JobEvent> = [
			{ _tag: "Started" },
			{ _tag: "Succeeded" },
			{ _tag: "FailedPermanently", error: "x" },
			retryable,
			{ _tag: "Cancelled", reason: "x" },
		];
		for (const status of statuses) {
			for (const event of events) {
				const result = move(status, event);
				expect(Result.isFailure(result)).toBe(
					!legal.has(`${status}:${event._tag}`),
				);
			}
		}
	});
});
