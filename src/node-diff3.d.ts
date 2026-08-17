// Ambient declarations for the "node-diff3" package.
// The package ships its own types at node_modules/node-diff3/src/diff3.d.ts,
// but they cannot be resolved under the project's current "node"
// moduleResolution setting (the package uses the "exports" field).
// This declaration mirrors the shipped signatures so type checking passes.
// Copied verbatim from node_modules/node-diff3/src/diff3.d.ts.
declare module "node-diff3" {
  export interface ILCSResult {
    buffer1index: number;
    buffer2index: number;
    chain: null | ILCSResult;
  }

  export function LCS<T>(buffer1: T[], buffer2: T[]): ILCSResult;

  export type ICommResult<T> =
    | {
        common: T[];
        buffer1?: never;
        buffer2?: never;
      }
    | {
        common?: never;
        buffer1: T[];
        buffer2: T[];
      };

  export function diffComm<T>(buffer1: T[], buffer2: T[]): ICommResult<T>[];

  export interface IDiffIndicesResult<T> {
    buffer1: [number, number];
    buffer1Content: T[];
    buffer2: [number, number];
    buffer2Content: T[];
  }

  export function diffIndices<T>(
    buffer1: T[],
    buffer2: T[]
  ): IDiffIndicesResult<T>[];

  export interface IChunk<T> {
    offset: number;
    length: number;
    chunk: T[];
  }

  export interface IPatchRes<T> {
    buffer1: IChunk<T>;
    buffer2: IChunk<T>;
  }

  export function diffPatch<T>(buffer1: T[], buffer2: T[]): IPatchRes<T>[];

  export function patch<T>(buffer: T[], patch: IPatchRes<T>[]): T[];

  export interface IStableRegion<T> {
    stable: true;
    buffer: "a" | "o" | "b";
    bufferStart: number;
    bufferLength: number;
    bufferContent: T[];
  }

  export interface IUnstableRegion<T> {
    stable: false;
    aStart: number;
    aLength: number;
    aContent: T[];
    bStart: number;
    bLength: number;
    bContent: T[];
    oStart: number;
    oLength: number;
    oContent: T[];
  }

  export type IRegion<T> = IStableRegion<T> | IUnstableRegion<T>;

  export function diff3MergeRegions<T>(a: T[], o: T[], b: T[]): IRegion<T>[];

  export interface MergeRegion<T> {
    ok?: T[];
    conflict?: {
      a: T[];
      aIndex: number;
      b: T[];
      bIndex: number;
      o: T[];
      oIndex: number;
    };
  }

  export interface MergeResult<T = string> {
    conflict: boolean;
    result: Array<T | string>;
  }

  export interface IMergeOptions {
    excludeFalseConflicts?: boolean;
    stringSeparator?: string | RegExp;
  }

  export interface IMergeLabelOptions extends IMergeOptions {
    label?: {
      a?: string;
      o?: string;
      b?: string;
    };
  }

  export function diff3Merge<T = string>(
    a: string | T[],
    o: string | T[],
    b: string | T[],
    options?: IMergeOptions
  ): MergeRegion<T>[];

  export function merge<T = string>(
    a: string | T[],
    o: string | T[],
    b: string | T[],
    options?: IMergeLabelOptions
  ): MergeResult<T>;

  export function mergeDiff3<T = string>(
    a: string | T[],
    o: string | T[],
    b: string | T[],
    options?: IMergeLabelOptions
  ): MergeResult<T>;

  export function mergeDigIn<T = string>(
    a: string | T[],
    o: string | T[],
    b: string | T[],
    options?: IMergeLabelOptions
  ): MergeResult<T>;
}
