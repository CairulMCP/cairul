export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type PluginOptions = Record<string, JsonValue>;

export type CheckContext = {
  projectDir: string;
  workItemUrl: string;
  signal: AbortSignal;
};

export type CheckResult = {
  status: 'passed' | 'pending' | 'error';
  detail?: string;
};

export type CheckKind = {
  execution?: 'background';
  validate?: (options: PluginOptions) => void | Promise<void>;
  run: (options: PluginOptions, context: CheckContext) => CheckResult | Promise<CheckResult>;
};

export type CairulPlugin = {
  checkKinds: Record<string, CheckKind>;
};

export type PluginFactory = (options: PluginOptions) => CairulPlugin | Promise<CairulPlugin>;
