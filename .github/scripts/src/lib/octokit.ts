import * as github from "@actions/github";

/**
 * Creates a pre-authenticated Octokit client from the provided token.
 *
 * Activities receive a `token` action input (the workflow GITHUB_TOKEN or a
 * short-lived App installation token) and call this helper to get a typed
 * Octokit instance. The client exposes REST and GraphQL methods along with
 * `octokit.paginate` for cursor-based pagination.
 *
 * @param token  A GitHub token with the scopes required by the calling activity.
 * @returns      A pre-authenticated Octokit client.
 */
export function getOctokit(token: string): ReturnType<typeof github.getOctokit> {
  return github.getOctokit(token);
}
