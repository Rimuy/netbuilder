import { Result } from "@rbxts/rust-classes";
import { NetBuilderResult } from "../definitions";

export = <T>(v: NetBuilderResult<T>): Result<T, string> =>
	v.Type === "Ok" ? Result.ok(v.Value) : Result.err(v.Message);
