import { Players, RunService } from "@rbxts/services";
import { Result, Vec } from "@rbxts/rust-classes";

import {
	NetBuilderMiddleware,
	MiddlewareCallback,
	RemoteDefinitionMembers,
	ThreadResult,
	NetBuilderResult,
	Optional,
} from "../definitions";

import GlobalMiddleware from "../Symbol/GlobalMiddleware";

import definitionInfo from "../Util/definitionInfo";

interface MiddlewareEntry {
	CurrentParameters: ReadonlyArray<unknown>;
	ReturnCallbacks: Array<(value: unknown) => unknown>;
	Result: ThreadResult;
}

/** @internal */
namespace MiddlewareResolver {
	export const timeout = 60;

	export const timeoutMsg = `middleware processing has timed out. (${MiddlewareResolver.timeout}s)`;

	export function CreateReceiver<F extends Callback>(
		definition: RemoteDefinitionMembers,
		callback: F,
	): (...args: unknown[]) => NetBuilderResult<ReturnType<F>> {
		return (...args: unknown[]) => {
			const player = getPlayerFromArgs(...args);
			const middlewares = getMiddlewares(definition);

			const executeFn = (...args: unknown[]) =>
				RunService.IsServer() ? callback(player, ...args) : callback(...args);

			if (middlewares.size() > 0) {
				const state = checkMiddlewares(definition, "Recv", args);

				if (state.Result.isErr()) {
					return {
						Result: "ERR",
						Message: state.Result.unwrapErr(),
					};
				}

				return {
					Result: "OK",
					Value: state.ReturnCallbacks.reduce(
						(acc, fn) => fn(acc),
						executeFn(...state.CurrentParameters),
					),
				};
			}

			return { Result: "OK", Value: executeFn(...args) };
		};
	}

	export function CreateSender(definition: RemoteDefinitionMembers, ...args: unknown[]) {
		const middlewares = getMiddlewares(definition);

		if (middlewares.size() > 0) {
			const state = checkMiddlewares(definition, "Send", args);

			return state.Result.and(
				Result.ok([
					state.CurrentParameters,
					(r: unknown) => state.ReturnCallbacks.reduce((acc, fn) => fn(acc), r),
				]),
			);
		}

		return Result.ok([args, (r: unknown) => r]);
	}

	function getMiddlewares(definition: RemoteDefinitionMembers) {
		const globalMiddlewares = definition.Namespace[GlobalMiddleware] as Array<NetBuilderMiddleware>;

		return Vec.fromPtr([...definition.Middlewares, ...globalMiddlewares])
			.dedupBy(({ Label: l1 }, { Label: l2 }) => l1 === l2 && l1 !== "Unknown")
			.asPtr();
	}

	function checkMiddlewares(
		definition: RemoteDefinitionMembers,
		kind: "Send" | "Recv",
		args: unknown[],
	) {
		const player = getPlayerFromArgs(...args);
		const middlewares = getMiddlewares(definition);

		const state: Optional<MiddlewareEntry, "Result"> = {
			CurrentParameters: resolveParameters(args),
			ReturnCallbacks: [],
		};

		for (const m of middlewares) {
			createChannel(definition, m[kind])
				.then(([fn, e]) => {
					task.spawn(fn, player, ...state.CurrentParameters);

					return e;
				})
				.then((result) => {
					if (!state.Result || state.Result.isOk()) {
						state.Result = result.andWith(([newParams, returnFn]) => {
							state.CurrentParameters = newParams ?? [];
							state.ReturnCallbacks.push(returnFn);

							return result;
						});
					}
				})
				.expect();

			if (state.Result?.isErr()) {
				break;
			}
		}

		return state as MiddlewareEntry;
	}

	function resolveParameters(args: unknown[]) {
		const newArgs = [...args];

		if (RunService.IsServer()) {
			(newArgs as defined[]).shift();
		}

		return newArgs;
	}

	function getPlayerFromArgs(...args: unknown[]) {
		if (RunService.IsClient()) {
			return Players.LocalPlayer;
		}

		return (args as [Player]).shift()!;
	}

	function createChannel(definition: RemoteDefinitionMembers, channel: MiddlewareCallback) {
		return Promise.resolve([
			coroutine.create(channel),
			coroutine.create((result: ThreadResult) => {
				coroutine.yield();

				return result;
			}),
			new Instance("BindableEvent"),
			Promise.delay(MiddlewareResolver.timeout).then(() => MiddlewareResolver.timeoutMsg),
		] as const)
			.then(([ch, co, bindable, timeout]) => {
				let isDone = false;

				const close = (result: ThreadResult) => {
					if (!isDone) {
						isDone = true;

						task.spawn(co, result);
						task.defer(coroutine.close, ch);

						timeout.cancel();
						bindable.Fire();

						coroutine.yield();
					}
				};

				const processNext = (args: unknown[], returnFn: (r: unknown) => unknown) =>
					close(Result.ok([args, returnFn]));
				const drop = (reason: string) => close(Result.err(reason));

				timeout.then((msg) => drop(`${definitionInfo(definition)} ${msg}`));

				return [
					ch,
					processNext,
					drop,
					Promise.fromEvent(bindable.Event)
						.tap(() => bindable.Destroy())
						.then(() => coroutine.resume(co)[1]),
				] as const;
			})
			.then(
				([ch, p, d, e]) =>
					[
						coroutine.resume(ch, definition, p, d)[1] as ReturnType<MiddlewareCallback>,
						e as Promise<ThreadResult>,
					] as const,
			);
	}
}

export = MiddlewareResolver;
