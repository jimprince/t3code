declare module "occt-import-js" {
  type ImportOptions = {
    readonly linearUnit: "millimeter" | "centimeter" | "meter" | "inch" | "foot";
    readonly linearDeflectionType: "bounding_box_ratio" | "absolute_value";
    readonly linearDeflection: number;
    readonly angularDeflection: number;
  };

  type ImportedMesh = {
    readonly name: string;
    readonly color?: readonly [number, number, number];
    readonly attributes: {
      readonly position: { readonly array: readonly number[] };
      readonly normal?: { readonly array: readonly number[] };
    };
    readonly index: { readonly array: readonly number[] };
  };

  type ImportResult = {
    readonly success: boolean;
    readonly meshes: readonly ImportedMesh[];
  };

  type OcctImport = {
    readonly ReadStepFile: (bytes: Uint8Array, options: ImportOptions) => ImportResult;
  };

  export default function initialize(options?: {
    readonly locateFile?: (path: string) => string;
  }): Promise<OcctImport>;
}

declare module "occt-import-js/dist/occt-import-js.wasm?url" {
  const url: string;
  export default url;
}
