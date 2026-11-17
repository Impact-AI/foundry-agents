/**
 * The root entry is deliberately light: the scrub, the processors, the probe
 * filter and the two structured lines, and nothing that opens a socket. The
 * Azure exporter, the Bun pipeline and the Next distro are `./bun`, `./next`
 * and `./settings`, so importing this to ask what `isProbePath` says drags in
 * no exporter and no distro. It does load the OpenTelemetry API and the
 * trace SDK's sampling types, which the probe filter is written against.
 */
export * from "./events";
export { demoteDuplicateServerSpan } from "./pipeline/duplicate-server-span";
export { ScrubbingLogRecordProcessor } from "./pipeline/log-processor";
export {
	installProbeFilter,
	ProbeFilteringSampler,
} from "./pipeline/probe-filter";
export {
	type ScrubbingOptions,
	ScrubbingSpanProcessor,
	scrubSpan,
} from "./pipeline/span-processor";
export * from "./scrub";
