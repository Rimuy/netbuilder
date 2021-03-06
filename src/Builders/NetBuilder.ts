import { OptionMut } from "@rbxts/rust-classes";

import {
	InferDefinitionId,
	NetBuilderMiddleware,
	NetBuilderSerializer,
	NetBuilderConfiguration,
	Definition,
	DefinitionMembers,
	DefinitionNamespace,
	SerializableClass,
	MiddlewareCallback,
	SerializableObject,
	SerializationType,
	SerializationMap as ISerializationMap,
	InferDefinitionTyping,
	InferDefinitionKind,
	ServerDefinition,
	ClientDefinition,
	SerializationDefinition,
} from "../definitions";

import ConfigurationBuilder from "./ConfigurationBuilder";

import ServerDispatcher from "../Communication/ServerDispatcher";
import ClientDispatcher from "../Communication/ClientDispatcher";

import Serialization from "../Core/Serialization";

import Configuration from "../Symbol/Configuration";
import GlobalMiddleware from "../Symbol/GlobalMiddleware";
import NamespaceId from "../Symbol/NamespaceId";
import NamespaceParent from "../Symbol/NamespaceParent";
import Serializables from "../Symbol/Serializables";
import Serializers from "../Symbol/Serializers";
import SerializationMap from "../Symbol/SerializationMap";

import symbolDictionary from "../Util/symbolDictionary";
import { DEFAULT_CONFIGURATION, IS_CLIENT, IS_SERVER } from "../Util/constants";

const enum Boundary {
	Server,
	Client,
}

type NetBuilderServer<R extends DefinitionNamespace> = {
	readonly [I in keyof R]: R[I] extends Definition
		? ServerDefinition<InferDefinitionKind<R[I]>, ServerDispatcher<InferDefinitionTyping<R[I]>>>
		: R[I] extends DefinitionNamespace
		? NetBuilderServer<R[I]>
		: never;
};

type NetBuilderClient<R extends DefinitionNamespace> = {
	readonly [I in keyof R]: R[I] extends Definition
		? ClientDefinition<InferDefinitionKind<R[I]>, ClientDispatcher<InferDefinitionTyping<R[I]>>>
		: R[I] extends DefinitionNamespace
		? NetBuilderClient<R[I]>
		: never;
};

type NetBuilderMiddlewareOptions = {
	/** Enables the middleware to be used globally. */
	Global?: boolean;
	/** Checks whether the middleware will be executed on the server or both. */
	ServerOnly: boolean;
} & (
	| {
			ServerOnly: false;
			/** Middleware callback that is executed before a request is sent. */
			Sender?: MiddlewareCallback<Callback>;
			/** Middleware callback that is executed when a request is received. */
			Receiver?: MiddlewareCallback<Callback>;
	  }
	| {
			ServerOnly: true;
			/** Middleware callback that behaves like a sender/receiver. */
			Callback: MiddlewareCallback<Callback>;
	  }
);

interface NetBuilderSerializerCreator<S> {
	Serialize(this: void, value: defined, definition: SerializationDefinition): S;
	Deserialize(this: void, serialized: S, definition: SerializationDefinition): defined;
}

interface Cache<R extends DefinitionNamespace> {
	Client: OptionMut<R>;
	Server: OptionMut<R>;
}

const middlewareFn: MiddlewareCallback<Callback> =
	(_remote, processNext) =>
	(_player, ...args) => {
		processNext(args);
	};

/** Builder for a dictionary of remote definitions. */
class NetBuilder<R extends DefinitionNamespace = {}, O extends keyof NetBuilder = never> {
	private definitions = new Array<Definition>();

	private middlewareList = new Array<NetBuilderMiddleware>();

	private namespaces = new Array<{ name: string; space: DefinitionNamespace }>();

	private configuration = DEFAULT_CONFIGURATION;

	private serializableClasses = new Array<SerializableClass>();

	private serializers = new Array<NetBuilderSerializer<defined>>();

	private readonly cache: Cache<R> = {
		Server: OptionMut.none<R>(),
		Client: OptionMut.none<R>(),
	};

	private readonly serializationMap: ISerializationMap = {
		Serializables: new Map(),
		Serializers: new Map(),
		SerializerClasses: new Map(),
	};

	private toString() {
		return "NetBuilder";
	}

	/** Creates a custom middleware. */
	public static CreateMiddleware<P extends Array<any>>(
		id: string,
		callback: (...args: P) => NetBuilderMiddlewareOptions,
	) {
		return <F extends Callback>(...args: P): NetBuilderMiddleware<F> => {
			const options = callback(...(args as never));
			const { Global = false, ServerOnly } = options;

			if (ServerOnly === true) {
				const { Callback } = options;

				const serverFn: MiddlewareCallback<Callback> =
					(definition, processNext, drop) =>
					(player, ...args) => {
						if (player && IS_SERVER) {
							Callback(definition, processNext, drop)(player, ...(args as never[]));
						} else {
							processNext(args);
						}
					};

				return {
					Id: id,
					GlobalEnabled: Global,
					Send: serverFn,
					Recv: serverFn,
				};
			}

			const { Sender = middlewareFn, Receiver = middlewareFn } = options;

			return {
				Id: id,
				GlobalEnabled: Global,
				Send: Sender,
				Recv: Receiver,
			};
		};
	}

	/** Creates a custom serializer. Useful for existing classes. */
	public static CreateSerializer<S>(
		object: object,
		methods: NetBuilderSerializerCreator<S>,
	): NetBuilderSerializer<S> {
		return {
			Class: object,
			Serialization(namespace, value, definition) {
				return {
					SerializationType: SerializationType.Custom,
					SerializationId: (
						symbolDictionary(namespace)[SerializationMap] as ISerializationMap
					).SerializerClasses.get(object as never)!.Id,
					Value: methods.Serialize(value, definition),
				};
			},
			Deserialization(serialized: S, definition) {
				return methods.Deserialize(serialized, definition);
			},
		};
	}

	/** Utility function for creating type checkers. */
	public static CreateTypeChecker<T>(
		checker: (value: unknown) => boolean | LuaTuple<[boolean, string]>,
	) {
		return checker as (value: unknown) => value is T;
	}

	private createDispatchers(boundary: Boundary, dict: Map<string, Definition | DefinitionNamespace>) {
		const Dispatcher = boundary === Boundary.Server ? ServerDispatcher : ClientDispatcher;

		function assign(
			input: Map<string, Definition | DefinitionNamespace>,
			output: Record<string, defined>,
		) {
			for (const [k, v] of input) {
				if (type(k) === "string") {
					if ("Id" in v && "Kind" in v) {
						output[k] = new Dispatcher(v as never);
					} else {
						output[k] = assign(v as never, {});
					}
				}
			}

			return table.freeze(output);
		}

		return assign(dict, {});
	}

	/** Binds a definition to the namespace. */
	public BindDefinition<D extends Definition>(definition: D) {
		this.definitions.push(definition);

		return this as unknown as NetBuilder<Reconstruct<R & { [_ in InferDefinitionId<D>]: D }>, O>;
	}

	/** Binds a child definition namespace. */
	public BindNamespace<S extends string, N extends DefinitionNamespace>(name: S, space: N) {
		this.namespaces.push({ name, space });

		return this as unknown as NetBuilder<Reconstruct<R & { [_ in S]: N }>, O>;
	}

	public Configure(
		config: ((builder: ConfigurationBuilder) => object) | Partial<NetBuilderConfiguration>,
	) {
		if (typeIs(config, "function")) {
			this.configuration = (config(new ConfigurationBuilder()) as ConfigurationBuilder)["Build"]();
		} else {
			for (const [k, v] of pairs(config)) {
				this.configuration[k] = v as never;
			}
		}

		return this as unknown as NetBuilder<R, O>;
	}

	/** Sets a list of middlewares valid for every descendant definition. */
	public UseGlobalMiddleware(middleware: NetBuilderMiddleware[]) {
		this.middlewareList = middleware;

		return this as unknown as Omit<
			NetBuilder<R, O | "UseGlobalMiddleware">,
			O | "UseGlobalMiddleware"
		>;
	}

	/** Sets a list serializers to the registry. Whenever a request is made, parameters and return values are (de)serialized if they match any of the provided serializable classes. */
	public UseSerialization(classes: SerializableObject[]) {
		this.serializableClasses = classes.filter(
			(v) => !Serialization.IsSerializer(v),
		) as Array<SerializableClass>;

		this.serializers = classes.filter((v) => Serialization.IsSerializer(v)) as Array<
			NetBuilderSerializer<defined>
		>;

		// eslint-disable-next-line roblox-ts/no-array-pairs
		for (const [i, obj] of ipairs(this.serializableClasses)) {
			this.serializationMap.Serializables.set(obj, i);
		}

		// eslint-disable-next-line roblox-ts/no-array-pairs
		for (const [i, obj] of ipairs(this.serializers)) {
			this.serializationMap.Serializers.set(obj, i);
			this.serializationMap.SerializerClasses.set(obj.Class, { Serializer: obj, Id: i });
		}

		return this as unknown as Omit<NetBuilder<R, O | "UseSerialization">, O | "UseSerialization">;
	}

	private _build() {
		const { definitions, namespaces } = this;
		const dict = new Map<string, Definition | DefinitionNamespace>();

		for (const { GlobalEnabled, Id } of this.middlewareList) {
			if (!GlobalEnabled) {
				error(`[netbuilder] The middleware "${Id}" is not globally enabled.`, 3);
			}
		}

		for (const d of definitions) {
			const def = d as unknown as DefinitionMembers;
			(def.Namespace as unknown) = dict;

			dict.set(def.Id, table.freeze(d));
		}

		for (const { name, space } of namespaces) {
			const s = symbolDictionary(space);

			s[NamespaceId] = name;
			s[NamespaceParent] = dict;
			s[Configuration] = s[Configuration]
				? { ...this.configuration, ...(s[Configuration] as NetBuilderConfiguration) }
				: this.configuration;

			dict.set(name, table.freeze(space));
		}

		const thisNamespace = symbolDictionary(dict);
		thisNamespace[Configuration] = this.configuration;
		thisNamespace[GlobalMiddleware] = this.middlewareList;
		thisNamespace[Serializables] = this.serializableClasses;
		thisNamespace[Serializers] = this.serializers;
		thisNamespace[SerializationMap] = this.serializationMap;

		return dict;
	}

	/** Returns a dictionary of remote definitions. */
	public AsNamespace() {
		return this._build() as unknown as R;
	}

	/** Creates dispatchers for both client and server. */
	public Build() {
		const { cache } = this;
		const definitions = this._build();

		return table.freeze({
			/**
			 * Generated server definitions
			 * @server
			 */
			Server: setmetatable(
				{},
				{
					__tostring: () => "NetBuilder.ServerDefinitions",
					__index: (_, key) => {
						if (!IS_SERVER) {
							throw "[netbuilder] Cannot access server definitions from a client.";
						}

						return cache.Server.getOrInsertWith(
							() => this.createDispatchers(Boundary.Server, definitions) as R,
						)[key as keyof R];
					},
				},
			) as NetBuilderServer<R>,
			/**
			 * Generated client definitions
			 * @client
			 */
			Client: setmetatable(
				{},
				{
					__tostring: () => "NetBuilder.ClientDefinitions",
					__index: (_, key) => {
						if (!IS_CLIENT) {
							throw "[netbuilder] Cannot access client definitions from the server.";
						}

						return cache.Client.getOrInsertWith(
							() => this.createDispatchers(Boundary.Client, definitions) as R,
						)[key as keyof R];
					},
				},
			) as NetBuilderClient<R>,
		});
	}
}

export = NetBuilder;
