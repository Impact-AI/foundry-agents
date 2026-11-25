import type { Attributes } from "@opentelemetry/api";
import type { Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";

/**
 * Which release a span came from, on the resource of every span a service
 * exports, so a reader can say which version runs from the spans alone.
 *
 * The stamp is on the resource and on every span's own attributes, since
 * Application Insights keeps a span's attributes on its row and a resource's
 * only as the role and the application version.
 *
 * The app reads the values and hands them in. A release workflow sets the
 * release's id, version and environment together with the image they
 * describe; Container Apps names the revision on every replica it runs, and
 * nothing else does, so a revision is also what says the process runs on
 * Container Apps. Outside a release the version is the image's tag; off
 * Container Apps, no revision and no cloud are claimed.
 */

/** The OpenTelemetry values for a process on Azure Container Apps. */
export const CONTAINER_APPS_CLOUD = Object.freeze({
	provider: "azure",
	platform: "azure_container_apps",
} as const);

export interface Release {
	/** `impact.release.id`: the release, the same in every environment it runs in. */
	id?: string;
	/** `impact.release.version`, and `service.version` when set. */
	version?: string;
	/** `deployment.environment.name`: `development` or `production`. */
	environment?: string;
	/** `impact.release.revision`: the Container Apps revision serving this process. */
	revision?: string;
}

export interface ServiceIdentity {
	/** `service.name`; one per service. */
	serviceName: string;
	/** The image tag, when the process knows it: the version outside a release. */
	serviceVersion?: string;
	release?: Release;
}

const value = (raw: string | undefined): string | undefined => {
	const trimmed = raw?.trim();
	return trimmed ? trimmed : undefined;
};

/**
 * The release stamp: `impact.release.id`, `impact.release.version`,
 * `impact.release.revision`, `deployment.environment.name`, `cloud.provider`
 * and `cloud.platform`, each where known. An attribute with no value is left
 * out, never sent empty.
 */
export function releaseStamp(release: Release | undefined): Attributes {
	const id = value(release?.id);
	const version = value(release?.version);
	const environment = value(release?.environment);
	const revision = value(release?.revision);
	return {
		...(id ? { "impact.release.id": id } : {}),
		...(version ? { "impact.release.version": version } : {}),
		...(revision ? { "impact.release.revision": revision } : {}),
		...(environment ? { "deployment.environment.name": environment } : {}),
		...(revision
			? {
					"cloud.provider": CONTAINER_APPS_CLOUD.provider,
					"cloud.platform": CONTAINER_APPS_CLOUD.platform,
				}
			: {}),
	};
}

/**
 * The resource every span of the process carries: `service.name`,
 * `service.version` (the release's version, else the image's tag), and the
 * release stamp. Azure Monitor's exporter reads only the service's name and
 * version off a resource (into the role and the application version), so
 * the stamp is also put on each span ({@link ReleaseStampProcessor}).
 */
export function resourceAttributes(identity: ServiceIdentity): Attributes {
	const serviceVersion =
		value(identity.release?.version) ?? value(identity.serviceVersion);
	return {
		"service.name": identity.serviceName,
		...(serviceVersion ? { "service.version": serviceVersion } : {}),
		...releaseStamp(identity.release),
	};
}

/**
 * Puts the release stamp on every span as it starts, as attributes of the
 * span's own. Azure Monitor's exporter writes a span's attributes into its
 * row's `customDimensions` and leaves every resource attribute but the
 * service's name and version off the row, so this is what lets a query of
 * Application Insights match a span to its release.
 */
export class ReleaseStampProcessor implements SpanProcessor {
	private readonly stamp: Attributes;

	constructor(release: Release | undefined) {
		this.stamp = releaseStamp(release);
	}

	onStart(span: Span): void {
		if (Object.keys(this.stamp).length > 0) span.setAttributes(this.stamp);
	}

	onEnd(): void {}

	forceFlush(): Promise<void> {
		return Promise.resolve();
	}

	shutdown(): Promise<void> {
		return Promise.resolve();
	}
}
