import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";

const workflowPath = fileURLToPath(
  new URL("../.github/workflows/deploy-compiler.yml", import.meta.url),
);
const ciWorkflowPath = fileURLToPath(
  new URL("../.github/workflows/ci.yml", import.meta.url),
);
const workflow = await readFile(workflowPath, "utf8");
const ciWorkflow = await readFile(ciWorkflowPath, "utf8");

function occurrences(value) {
  return workflow.split(value).length - 1;
}

function shellRunBlocks() {
  const lines = workflow.split("\n");
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)run: \|$/u.exec(lines[index]);
    if (!match) continue;
    const contentIndent = match[1].length + 2;
    const content = [];
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (
        line.trim() !== "" &&
        line.length - line.trimStart().length < contentIndent
      ) {
        index -= 1;
        break;
      }
      content.push(
        line.length >= contentIndent ? line.slice(contentIndent) : "",
      );
    }
    blocks.push(content.join("\n"));
  }
  return blocks;
}

function logicalShellCommands() {
  return shellRunBlocks().flatMap((block) =>
    block
      .replace(/\\\n\s*/gu, " ")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

test("compiler deployment is manual-only, exact-confirmed, and pinned to current main", () => {
  const trigger = workflow.slice(
    workflow.indexOf("on:\n"),
    workflow.indexOf("\npermissions:"),
  );
  assert.match(trigger, /^on:\n {2}workflow_dispatch:/u);
  for (const forbidden of ["push:", "pull_request:", "schedule:", "release:"]) {
    assert.doesNotMatch(trigger, new RegExp(`\\b${forbidden}`, "u"));
  }
  for (const confirmation of [
    "DEPLOY_STAGING_COMPILER",
    "DEPLOY_PRODUCTION_COMPILER",
    "BOOTSTRAP_STAGING_COMPILER_ECR",
    "BOOTSTRAP_PRODUCTION_COMPILER_ECR",
  ]) {
    assert.match(workflow, new RegExp(confirmation, "u"));
  }
  assert.match(workflow, /RELEASE_EVENT" != "workflow_dispatch"/u);
  assert.match(workflow, /RELEASE_REPOSITORY" != "jambrike\/firelight"/u);
  assert.match(workflow, /RELEASE_REF" != "refs\/heads\/main"/u);
  assert.match(workflow, /\^\[0-9a-f\]\{40\}\$/u);
  assert.match(workflow, /staging_run_id:/u);
  assert.match(workflow, /staging_evidence_sha256:/u);
  assert.match(
    workflow,
    /Production requires one exact accepted staging run and evidence hash/u,
  );
  assert.ok(occurrences("git rev-parse FETCH_HEAD") >= 4);
  assert.match(workflow, /uses: \.\/\.github\/workflows\/ci\.yml/u);
  assert.match(
    workflow,
    /^env:\n {2}FIRELIGHT_COMPILER_RELEASE_BUILD_ID: \$\{\{ github\.sha \}\}$/mu,
  );
});

test("AWS access is OIDC-only and every third-party action is immutable", () => {
  assert.ok(occurrences("id-token: write") >= 4);
  assert.ok(
    occurrences(
      "aws-actions/configure-aws-credentials@e6de054238d6b7531b4efff3b6587d9aade6a06c",
    ) >= 4,
  );
  assert.ok(
    occurrences("allowed-account-ids: ${{ vars.AWS_ACCOUNT_ID }}") >= 4,
  );
  assert.ok(occurrences("unset-current-credentials: true") >= 4);
  assert.ok(occurrences("terraform_wrapper: false") >= 4);
  assert.ok(occurrences("compiler-${{ inputs.environment }}") >= 4);
  assert.ok(occurrences("verify_aws_identity.py") >= 4);
  assert.ok(occurrences("before Terraform init") >= 3);
  assert.ok(
    occurrences(
      "Pre-existing AWS credentials are forbidden; GitHub OIDC is required.",
    ) >= 4,
  );
  assert.doesNotMatch(
    workflow,
    /secrets\.AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)/u,
  );

  const actionUses = [...workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+).*$/gmu)]
    .map((match) => match[1])
    .filter((reference) => !reference.startsWith("./"));
  assert.ok(actionUses.length > 0);
  for (const reference of actionUses) {
    assert.match(reference, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/u);
  }
});

test("ECR bootstrap is a resumable sentinel-bound two-approval saved-plan operation", () => {
  assert.match(workflow, /^ {2}ecr-bootstrap-plan:/mu);
  assert.match(workflow, /^ {2}ecr-bootstrap-apply:/mu);
  assert.ok(occurrences("materialize_release_config.py --ecr-bootstrap") >= 2);
  assert.equal(occurrences("-target=aws_ecr_repository.compiler"), 2);
  assert.equal(occurrences("-target=aws_ecr_lifecycle_policy.compiler"), 2);
  assert.doesNotMatch(
    workflow,
    /-target=(?:aws_ecs|aws_lambda|aws_vpc|terraform_data\.release_gate)/u,
  );
  assert.match(workflow, /firelight\.compiler-ecr-plan/u);
  assert.match(workflow, /terraform_data\.operator_gate/u);
  assert.equal(occurrences("verify_ecr_bootstrap_plan.py"), 2);
  assert.match(
    workflow,
    /verify_ecr_bootstrap_plan\.py --require-complete "\$post_plan_json_path"/u,
  );
  assert.match(workflow, /did not converge to zero drift/u);
  assert.match(
    workflow,
    /terraform state show -no-color terraform_data\.operator_gate/u,
  );
  assert.match(workflow, /imageTagMutability == "IMMUTABLE"/u);
  assert.match(workflow, /imageScanningConfiguration\.scanOnPush == true/u);
  assert.match(
    workflow,
    /\(inputs\.ecr_bootstrap_confirmation == '' && needs\.ecr-bootstrap-apply\.result == 'skipped'\) \|\|\n\s+\(inputs\.ecr_bootstrap_confirmation != '' && needs\.ecr-bootstrap-apply\.result == 'success'\)/u,
  );
  assert.doesNotMatch(
    workflow,
    /needs\.ecr-bootstrap-apply\.result == 'success' \|\| needs\.ecr-bootstrap-apply\.result == 'skipped'/u,
  );
});

test("full release binds a tested amd64 image to its registry digest and clean scan", () => {
  assert.match(workflow, /docker build --platform linux\/amd64/u);
  assert.match(
    workflow,
    /Build and test a missing staging linux\/amd64 compiler image\n {8}if: inputs\.environment == 'staging' && steps\.canonical-image\.outputs\.exists == 'false'/u,
  );
  const resolveIndex = workflow.indexOf(
    "Resolve the immutable canonical compiler image before any build",
  );
  const buildIndex = workflow.indexOf(
    "Build and test a missing staging linux/amd64 compiler image",
  );
  assert.ok(resolveIndex > 0 && resolveIndex < buildIndex);
  assert.match(workflow, /verify_lesson_sketches\.py --root \/fixtures/u);
  assert.match(
    workflow,
    /candidate-\$RELEASE_SHA-\$RELEASE_RUN_ID-\$RELEASE_RUN_ATTEMPT/u,
  );
  assert.match(workflow, /docker push "\$repository_url:\$candidate_tag"/u);
  assert.match(workflow, /registry_image_id" != "\$promotion_image_id/u);
  assert.doesNotMatch(workflow, /FIRELIGHT_STAGING_ECR_ACCOUNT_ID/u);
  assert.match(workflow, /staging_repository_url="\$AWS_ACCOUNT_ID/u);
  assert.match(
    workflow,
    /skopeo copy[\s\S]*?--preserve-digests[\s\S]*?"docker:\/\/\$promotion_image"[\s\S]*?"docker:\/\/\$repository_url:\$candidate_tag"/u,
  );
  assert.doesNotMatch(workflow, /docker pull[^\n]*"\$promotion_image"/u);
  assert.doesNotMatch(workflow, /docker tag "\$promotion_image"/u);
  assert.match(
    workflow,
    /docker tag "\$IMAGE_TAG" "\$repository_url:\$candidate_tag"/u,
  );
  assert.match(
    workflow,
    /production candidate digest does not match accepted staging/u,
  );
  assert.doesNotMatch(
    workflow,
    /docker push "\$repository_url:\$RELEASE_SHA"/u,
  );
  assert.match(workflow, /aws ecr batch-get-image/u);
  assert.match(workflow, /aws ecr put-image/u);
  assert.match(workflow, /--image-manifest "file:\/\/\$manifest_file"/u);
  assert.match(workflow, /--image-digest "\$candidate_digest"/u);
  assert.match(workflow, /manifest_digest" != "\$candidate_digest/u);
  assert.match(workflow, /aws ecr start-image-scan/u);
  assert.match(workflow, /reuse_existing=true/u);
  assert.match(
    workflow,
    /if \[\[ "\$FIRELIGHT_COMPILER_ENVIRONMENT" == "staging" && "\$reuse_existing" != "true" \]\]; then\n {12}promotion_image_id="\$\(docker image inspect "\$IMAGE_TAG"[\s\S]*?else\n {12}promotion_image_id="\$registry_image_id"/u,
  );
  const candidateScanIndex = workflow.indexOf(
    "The exact ECR image scan did not clear",
  );
  const manifestRetagIndex = workflow.indexOf("aws ecr put-image");
  assert.ok(candidateScanIndex > 0 && candidateScanIndex < manifestRetagIndex);
  assert.ok(occurrences("^sha256:[0-9a-f]{64}$") >= 3);
  assert.ok(occurrences("image-scan-complete") >= 2);
  assert.ok(occurrences("findingSeverityCounts.HIGH") >= 2);
  assert.ok(occurrences("findingSeverityCounts.CRITICAL") >= 2);
  assert.ok(occurrences("verify_release_config.py") >= 2);
  assert.match(workflow, /terraform plan -detailed-exitcode/u);
});

test("saved plans use an immutable protected S3 handoff and apply without replanning", () => {
  assert.match(workflow, /^ {2}plan:/mu);
  assert.match(workflow, /^ {2}apply:/mu);
  assert.match(workflow, /firelight\.compiler-plan/u);
  assert.equal(occurrences("actions/upload-artifact@"), 1);
  assert.equal(occurrences("actions/download-artifact@"), 0);
  assert.doesNotMatch(workflow, /compiler-(?:ecr-)?plan-\$\{\{/u);
  assert.ok(occurrences("aws s3api put-object") === 2);
  assert.ok(occurrences("--if-none-match '*'") === 2);
  assert.ok(occurrences("--server-side-encryption aws:kms") === 2);
  assert.ok(
    occurrences('--ssekms-key-id "$FIRELIGHT_TERRAFORM_STATE_KMS_KEY_ARN"') ===
      2,
  );
  assert.ok(occurrences("aws s3api get-object") === 4);
  assert.equal(occurrences("aws s3api head-object"), 6);
  assert.equal(occurrences("--version-id"), 6);
  assert.ok(occurrences(".VersionId") >= 8);
  assert.ok(occurrences('--expected-bucket-owner "$AWS_ACCOUNT_ID"') >= 12);
  assert.ok(
    occurrences(
      "firelight/compiler/${{ inputs.environment }}/saved-plans/${{ github.run_id }}/${{ github.run_attempt }}",
    ) === 4,
  );
  for (const binding of [
    "manifestObjectKey",
    "planObjectKey",
    "planTextObjectKey",
    "planSize",
    "planTextSize",
    "runAttempt",
    "runId",
  ]) {
    assert.match(workflow, new RegExp(binding, "u"));
  }
  assert.match(workflow, /\.version == 2/u);
  assert.match(workflow, /full-plan-manifest/u);
  assert.match(workflow, /ecr-bootstrap-manifest/u);
  for (const field of [
    "backend_sha256",
    "variables_sha256",
    "state_serial",
    "state_lineage",
    "plan_sha256",
    "plan_text_sha256",
    "manifest_sha256",
  ]) {
    assert.match(workflow, new RegExp(field, "u"));
  }
  const applyCommands = workflow.match(/^\s*terraform apply .*$/gmu) ?? [];
  assert.equal(applyCommands.length, 2);
  assert.ok(
    applyCommands.every((command) =>
      /-auto-approve "\$(?:plan_path|PLAN_PATH)" > "\$apply_stdout_path" 2> "\$apply_stderr_path"$/u.test(
        command,
      ),
    ),
  );
  assert.doesNotMatch(workflow, /terraform apply[^\n]*(?:-var-file|-target)/u);
  assert.match(
    workflow,
    /Terraform state changed after the complete plan was approved/u,
  );
});

test("Terraform plan and apply process streams never enter Actions logs", () => {
  const commands = logicalShellCommands();
  const planCommands = commands.filter((command) =>
    command.startsWith("terraform plan "),
  );
  const applyCommands = commands.filter((command) =>
    command.startsWith("terraform apply "),
  );

  assert.equal(planCommands.length, 3);
  assert.equal(applyCommands.length, 2);
  for (const command of [...planCommands, ...applyCommands]) {
    assert.match(command, /> "\$[a-z_]+stdout_path"/u);
    assert.match(command, /2> "\$[a-z_]+stderr_path"$/u);
    assert.doesNotMatch(command, /\btee\b|GITHUB_(?:OUTPUT|STEP_SUMMARY)/u);
  }

  assert.equal(
    commands.filter((command) => command === "plan_status=$?").length,
    2,
  );
  assert.equal(
    commands.filter((command) => command === "post_plan_status=$?").length,
    1,
  );
  assert.equal(
    commands.filter((command) => command === "apply_status=$?").length,
    2,
  );
  assert.match(
    workflow,
    /if \[\[ \$plan_status -ne 0 && \$plan_status -ne 2 \]\]/u,
  );
  assert.match(workflow, /if \[\[ \$post_plan_status -ne 0 \]\]/u);
  assert.ok(occurrences("chmod 600 --") >= 5);
  assert.doesNotMatch(
    workflow,
    /\b(?:cat|head|tail|sed|awk)\b[^\n]*(?:plan|apply)_(?:stdout|stderr)_path/u,
  );
});

test("token parity gates every ECR mutation and both Terraform applies", () => {
  assert.ok(occurrences("aws secretsmanager get-secret-value") >= 4);
  assert.ok(occurrences("hmac.compare_digest") >= 4);

  const bootstrapApply = workflow.slice(
    workflow.indexOf("\n  ecr-bootstrap-apply:"),
    workflow.indexOf("\n  plan:"),
  );
  const bootstrapParityIndex = bootstrapApply.indexOf(
    "Re-prove token parity immediately before the ECR bootstrap apply",
  );
  const bootstrapTerraformApplyIndex = bootstrapApply.indexOf(
    'terraform apply -input=false -auto-approve "$PLAN_PATH"',
  );
  assert.ok(
    bootstrapParityIndex > 0 &&
      bootstrapParityIndex < bootstrapTerraformApplyIndex,
  );
  assert.match(
    bootstrapApply.slice(bootstrapParityIndex, bootstrapTerraformApplyIndex),
    /hmac\.compare_digest/u,
  );

  const planSection = workflow.slice(
    workflow.indexOf("\n  plan:"),
    workflow.indexOf("\n  apply:"),
  );
  const preEcrParityIndex = planSection.indexOf(
    "Prove token parity before any compiler ECR write",
  );
  const registryMutationIndex = planSection.indexOf(
    "Reuse or promote, test, scan, and bind the exact registry digest",
  );
  assert.ok(preEcrParityIndex > 0 && preEcrParityIndex < registryMutationIndex);
  assert.match(
    planSection.slice(preEcrParityIndex, registryMutationIndex),
    /hmac\.compare_digest/u,
  );

  const applySection = workflow.slice(workflow.indexOf("\n  apply:"));
  const fixtureIndex = applySection.indexOf(
    "Install dependencies and export release fixtures before credential access",
  );
  const oidcIndex = applySection.indexOf(
    "Assume the environment deploy role with GitHub OIDC",
  );
  const applyParityIndex = applySection.indexOf(
    "Re-prove token parity immediately before the complete Terraform apply",
  );
  const completeApplyIndex = applySection.indexOf(
    'terraform apply -input=false -auto-approve "$PLAN_PATH"',
  );
  assert.ok(fixtureIndex > 0 && fixtureIndex < oidcIndex);
  assert.ok(applySection.indexOf("npm ci") < oidcIndex);
  assert.equal(
    applySection.lastIndexOf("npm ci"),
    applySection.indexOf("npm ci"),
  );
  assert.ok(
    applyParityIndex > oidcIndex && applyParityIndex < completeApplyIndex,
  );
  assert.match(
    applySection.slice(applyParityIndex, completeApplyIndex),
    /hmac\.compare_digest/u,
  );
  assert.ok(
    applySection.indexOf(
      "Prove the protected token matches the AWS secret without logging either value",
    ) > completeApplyIndex,
  );
});

test("Terraform initialization is pinned to the committed provider lock", () => {
  const compilerInitCommands =
    workflow.match(/^\s*terraform init .*$/gmu) ?? [];
  assert.equal(compilerInitCommands.length, 5);
  assert.ok(
    compilerInitCommands.every((command) =>
      command.includes("-lockfile=readonly"),
    ),
  );

  const ciInitCommands =
    ciWorkflow.match(/^\s*run: terraform init .*$/gmu) ?? [];
  assert.equal(ciInitCommands.length, 1);
  assert.ok(ciInitCommands[0].includes("-lockfile=readonly"));
});

test("post-apply acceptance proves health, release identity, token parity, and a real compile", () => {
  for (const evidence of [
    "aws ecs wait services-stable",
    "describe-target-health",
    "imageDigest == $digest",
    "Code.ResolvedImageUri",
    "aws lambda get-alias",
    "FunctionVersion",
    "aws ecr get-repository-policy",
    "LambdaECRImageRetrievalPolicy",
    'Principal == {"Service":"lambda.amazonaws.com"}',
    'Condition.ArnEquals == {"aws:SourceArn":$gatewayArn}',
    'Condition.StringEquals == {"aws:SourceAccount":$account}',
    "terraform output -raw compiler_gateway_function_url",
    "aws lambda get-policy",
    "lambda:InvokeFunctionUrl",
    "lambda:InvokedViaFunctionUrl",
    "::add-mask::",
    "aws secretsmanager get-secret-value",
    "hmac.compare_digest",
    "FIRELIGHT_COMPILER_BUILD_ID",
    "FIRELIGHT_COMPILER_ENVIRONMENT",
    "FIRELIGHT_COMPILER_IMAGE_DIGEST",
    "FIRELIGHT_COMPILER_SERVICE_NAME",
    "export-lesson-sketches.mjs",
    "probe_deployment.py",
    "first_spark/first_spark.ino",
  ]) {
    assert.ok(
      workflow.includes(evidence),
      `missing post-apply evidence: ${evidence}`,
    );
  }
  assert.match(workflow, /Protected external handoff still required/u);
  assert.match(workflow, /exact approved image digest/u);
  assert.match(
    workflow,
    /GITHUB_TOKEN intentionally cannot administer environment secrets/u,
  );
  assert.doesNotMatch(workflow, /gh secret set|wrangler secret put/u);
});

test("production consumes exact accepted staging evidence before any AWS write", () => {
  const evidenceJobIndex = workflow.indexOf("\n  promotion-evidence:");
  const evidenceIndex = workflow.indexOf(
    "node scripts/verify-compiler-staging-evidence.mjs",
  );
  const bootstrapIndex = workflow.indexOf("\n  ecr-bootstrap-plan:");
  const isolationJobIndex = workflow.indexOf("\n  environment-isolation:");
  const isolationProofIndex = workflow.indexOf(
    "Materialize and bind compiler isolation before any AWS access",
  );
  const firstOidcIndex = workflow.indexOf(
    "name: Assume the environment deploy role with GitHub OIDC",
  );
  assert.ok(evidenceJobIndex > workflow.indexOf("\n  verify:"));
  assert.ok(evidenceIndex > evidenceJobIndex && evidenceIndex < bootstrapIndex);
  assert.ok(
    isolationJobIndex > evidenceIndex && isolationJobIndex < bootstrapIndex,
  );
  assert.ok(
    isolationProofIndex > isolationJobIndex &&
      isolationProofIndex < bootstrapIndex,
  );
  assert.ok(evidenceIndex < firstOidcIndex);
  assert.ok(isolationProofIndex < firstOidcIndex);
  assert.equal(
    occurrences("node scripts/verify-compiler-staging-evidence.mjs"),
    1,
  );
  assert.match(
    workflow,
    /ecr-bootstrap-plan:\n {4}needs:\n {6}- verify\n {6}- promotion-evidence/u,
  );
  assert.match(
    workflow,
    /ecr-bootstrap-plan:[\s\S]*?needs:[\s\S]*?- environment-isolation[\s\S]*?runs-on:/u,
  );
  assert.match(
    workflow,
    /plan:[\s\S]*?needs:[\s\S]*?- environment-isolation[\s\S]*?runs-on:/u,
  );
  assert.match(
    workflow,
    /FIRELIGHT_COMPILER_STAGING_RUN_ID: \$\{\{ inputs\.staging_run_id \}\}/u,
  );
  assert.match(
    workflow,
    /FIRELIGHT_COMPILER_STAGING_EVIDENCE_SHA256: \$\{\{ inputs\.staging_evidence_sha256 \}\}/u,
  );
  assert.match(
    workflow,
    /candidate_digest" != "\$ACCEPTED_STAGING_IMAGE_DIGEST/u,
  );
  for (const fingerprint of [
    "aws_account_id_sha256",
    "backend_location_sha256",
    "state_kms_key_sha256",
    "auth_secret_sha256",
    "vpc_cidr_sha256",
  ]) {
    assert.match(workflow, new RegExp(`staging_compiler_${fingerprint}`, "u"));
  }
  for (const peerArgument of [
    "--peer-aws-account-id-sha256",
    "--peer-backend-location-sha256",
    "--peer-state-kms-key-sha256",
    "--peer-auth-secret-sha256",
    "--peer-vpc-cidr-sha256",
  ]) {
    assert.match(workflow, new RegExp(peerArgument, "u"));
  }
  assert.match(workflow, /needs\.environment-isolation\.result == 'success'/u);
  assert.match(
    workflow,
    /APPLY_CONFIG_DIRECTORY: \$\{\{ steps\.approved-plan\.outputs\.config_dir \}\}/u,
  );
  assert.match(workflow, /FIRELIGHT_COMPILER_AWS_ACCOUNT_ID_SHA256=/u);
  assert.match(workflow, /EXPECTED_AWS_ACCOUNT_ID_SHA256/u);
  assert.match(
    workflow,
    /protected compiler isolation snapshot changed before the ECR plan/u,
  );
  assert.match(
    workflow,
    /protected compiler isolation snapshot changed before AWS access/u,
  );
  assert.match(
    workflow,
    /protected compiler isolation snapshot changed before the complete plan/u,
  );
  const bootstrapReadIndex = workflow.indexOf(
    "Prove production can read the accepted staging image before bootstrap",
  );
  const firstTerraformInitIndex = workflow.indexOf("terraform init");
  assert.ok(bootstrapReadIndex > firstOidcIndex);
  assert.ok(bootstrapReadIndex < firstTerraformInitIndex);
  const planSection = workflow.slice(
    workflow.indexOf("\n  plan:"),
    workflow.indexOf("\n  apply:"),
  );
  assert.ok(
    planSection.indexOf(
      "Re-prove the protected compiler snapshot before AWS access",
    ) <
      planSection.indexOf(
        "Assume the environment deploy role with GitHub OIDC",
      ),
  );
  assert.match(
    workflow,
    /--environment staging[\s\S]*?capture-compiler-staging-evidence\.mjs/u,
  );
  assert.match(
    workflow,
    /Capture the accepted staging compiler promotion evidence/u,
  );
  assert.match(workflow, /capture-compiler-staging-evidence\.mjs/u);
  assert.match(workflow, /retention-days: 30/u);
});

test("every embedded compiler workflow shell block parses as Bash", () => {
  const blocks = shellRunBlocks();
  assert.ok(blocks.length > 10);
  for (const [index, block] of blocks.entries()) {
    const result = spawnSync("bash", ["-n"], {
      input: block,
      encoding: "utf8",
    });
    assert.equal(
      result.status,
      0,
      `run block ${index + 1} is invalid Bash: ${result.stderr}`,
    );
  }
});
