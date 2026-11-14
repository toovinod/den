import { Context, Effect, Layer, TxReentrantLock } from "effect";

// Archiving stops a workspace's agents, terminals and scripts and then removes its folder. Work that
// checked the workspace was active just before would otherwise start in the middle of that and
// outlive the archive. Starts share the lock per workspace; an archive holds it alone, so a start
// waits for the archive and then sees the workspace's new status, archived or still active.
export class WorkspaceLock extends Context.Service<
	WorkspaceLock,
	{
		// For the check that the workspace is active and the start that relies on it, not the work itself.
		readonly starting: <A, E, R>(workspaceId: string, start: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
		readonly archiving: <A, E, R>(workspaceId: string, archive: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
	}
>()("octopus/daemon/workspaces/WorkspaceLock") {
	static readonly layer = Layer.effect(
		WorkspaceLock,
		Effect.sync(() => {
			const locks = new Map<string, TxReentrantLock.TxReentrantLock>();
			// Picked in one synchronous step, so two fibers never end up with different locks.
			const lockFor = (workspaceId: string) =>
				Effect.map(TxReentrantLock.make(), (fresh) => {
					const existing = locks.get(workspaceId);
					if (existing !== undefined) return existing;
					locks.set(workspaceId, fresh);
					return fresh;
				});
			return WorkspaceLock.of({
				starting: (workspaceId, start) =>
					Effect.flatMap(lockFor(workspaceId), (lock) => TxReentrantLock.withReadLock(lock, start)),
				archiving: (workspaceId, archive) =>
					Effect.flatMap(lockFor(workspaceId), (lock) =>
						TxReentrantLock.withWriteLock(
							lock,
							// An archived workspace takes no more work, so its lock is not needed again. A start
							// still waiting on it reads the archived status like one that comes later.
							Effect.tap(archive, () => Effect.sync(() => locks.delete(workspaceId))),
						),
					),
			});
		}),
	);
}
