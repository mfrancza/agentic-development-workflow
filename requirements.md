=Summary=

The goal of this project is to create a system for integrating coding agents into issue-based software development lifecycle.

Agents will have their own identities and development environments, allowing policies enforcing human review and limiting agents to the level of access needed for the task.

=MVP Workflow=

The user creates a Github issue and assigns it to the claude develoepr agent.

This triggers running a container with the issue passed in as a parameter.

The agent reads the issue, creates a branch for it, and implements a solution.

It then creates a PR and assigns human or AI reviwers to it.

The developer agent waits for the checks and updates the PR based on the results if any of them fail.

When a review is posted, the developer agent reads the comments, updates the branch based on the feedback, and resoponds.

When a response is posted, the AI reviewer reviews the code and responds or closes conversations for issues that are addressed.

When all the issues are addressed, the AI reviewer approves the PR.

When all reviewers have approved, the PR is merged.

The developer agent waits for the deployment to complete.  If it doesn't succeed, the agent diagnoses the failure and creates a new PR to fix it.

Once the deployment completes, the agent container shuts down.

=Requirements=

The agenst should have separate identities from the user in Github and dependencies, so that they can be distinguished during PRs and the agent can have limited permissions.

The development agent should run in a container which is separate from the credentials of the user.

The agents should interact with humans and other agents via comments in issues and PRs.

The MVP project should include:
-The Dockerfile for the container running the development agents
-Terraform for 
-- Setting up a Github repo
-- Setting up branch protection rules to rqeuire independent PR approval and remove agent's abilty to change main branch outside of PRs
-- Creating the github identities for the agents
-- Setting up github actions to run the agents in containers when the PR is assigned to an agent identity 
-A guide on how to run developer and code reviewer agents locally
