import type { Attributes } from "@opentelemetry/api";

/**
 * Which release a span came from, on the resource of every span a service
 * exports, so a reader can say which version runs from the spans alone.
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
 * The resource every span of the process carries: `service.name`,
 * `service.version` (the release's version, else the image's tag), and,
 * where known, `impact.release.id`, `impact.release.version`,
 * `impact.release.revision`, `deployment.environment.name`, `cloud.provider`
 * and `cloud.platform`. An attribute with no value is left out, never sent
 * empty.
 */
export function resourceAttributes(identity: ServiceIdentity): Attributes {
	const id = value(identity.release?.id);
	const version = value(identity.release?.version);
	const environment = value(identity.release?.environment);
	const revision = value(identity.release?.revision);
	const serviceVersion = version ?? value(identity.serviceVersion);
	return {
		"service.name": identity.serviceName,
		...(serviceVersion ? { "service.version": serviceVersion } : {}),
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
