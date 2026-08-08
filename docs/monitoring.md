# Monitoring and hosted acceptance

The compiler monitoring resources and public status probes are implemented in
the repository. They are not evidence of a hosted rollout by themselves: an
operator must still apply each environment's Terraform, connect and confirm the
approved alert recipients, run the staging drill, and retain the acceptance
record. No AWS apply, subscription, notification, or fault injection is run by
the local test suite.

## Compiler signals

Terraform creates the `${service_name}-operations` CloudWatch dashboard and 11
alarms. Every alarm sends both `ALARM` and recovery (`OK`) transitions to the
encrypted `${service_name}-alerts` SNS topic.

| Surface | Alarm condition | Evaluation | Missing data |
| --- | --- | --- | --- |
| Lambda Function URL | `Url5xxCount >= 1` | sum over 5 minutes | not breaching |
| Lambda gateway | `Errors >= 1` | sum over 5 minutes | not breaching |
| Lambda gateway | `Throttles >= 1` | sum over 5 minutes | not breaching |
| Lambda gateway | `Duration >= 40,000 ms` | maximum over 5 minutes | not breaching |
| ECS service | `RunningTaskCount < desired_count` | 2 of 2 one-minute periods | breaching |
| ECS service | `CPUUtilization >= 90%` | 3 of 3 one-minute periods | not breaching |
| ECS service | `MemoryUtilization >= 85%` | 3 of 3 one-minute periods | not breaching |
| ALB targets | `UnHealthyHostCount >= 1` or target metric absent | 2 of 2 one-minute periods | breaching |
| ALB targets | `HTTPCode_Target_5XX_Count >= 1` | sum over 5 minutes | not breaching |
| ALB targets | `TargetConnectionErrorCount >= 1` | sum over 5 minutes | not breaching |
| ALB targets | `TargetResponseTime >= 35 s` | maximum over 5 minutes | not breaching |

The Function URL and invocation alarms use the gateway function name plus its
`live` alias resource. ALB alarms use both exact `LoadBalancer` and
`TargetGroup` ARN suffixes. ECS utilization uses the cluster and service names;
running tasks uses the corresponding Container Insights dimensions.

Traffic-dependent metrics may legitimately be absent when the service is idle,
so they treat missing data as healthy. `RunningTaskCount` and
`UnHealthyHostCount` are different: Container Insights can stop emitting the
former when no task is running, and ALB stops emitting the latter when no target
is registered. Either absence is treated as an outage. The dashboard shows the
corresponding Lambda, desired and running ECS task, CPU/memory, and ALB
health/error/latency series.

## Encrypted alert routing

The SNS topic uses a dedicated customer-managed KMS key rather than
`alias/aws/sns`. The key rotates automatically and has a 30-day deletion
window. Its policy enables account IAM administration and grants the CloudWatch
service only `kms:GenerateDataKey*` and `kms:Decrypt`, scoped to this account and
the `${service_name}-*` alarm ARN prefix. The topic policy separately permits:

- account IAM administration, subscription management, and test publishing;
- `cloudwatch.amazonaws.com` publishing only when `aws:SourceAccount` is the
  current account and `aws:SourceArn` is the service alarm prefix.

Recipient addresses and escalation credentials are deliberately not Terraform
variables, resources, outputs, or state. After apply, a named primary and backup
recipient must subscribe through the approved alerting system and confirm their
subscriptions. The acceptance role needs narrowly scoped `sns:Publish` and the
KMS permissions required to publish to the encrypted topic; the resource and key
policies make that delegation possible without granting public access.

The non-sensitive Terraform outputs identify the resources:

```sh
terraform -chdir=compiler-service/terraform output -raw compiler_alerts_topic_arn
terraform -chdir=compiler-service/terraform output -raw compiler_dashboard_name
```

Send a content-free routing test from an approved operator session. Do not put
learner data, source, artifacts, tokens, recipient addresses, or incident detail
in the subject or message.

```sh
COMPILER_ALERTS_TOPIC_ARN="$(terraform -chdir=compiler-service/terraform output -raw compiler_alerts_topic_arn)"
aws sns publish \
  --region eu-west-1 \
  --topic-arn "$COMPILER_ALERTS_TOPIC_ARN" \
  --subject "Firelight compiler alert routing test" \
  --message "Synthetic routing test; no customer data."
```

Record only the environment, UTC time, returned message ID, and primary/backup
delivery confirmations in the acceptance evidence.

## Public status probes

`.github/workflows/public-probes.yml` runs every five minutes and can also be
started manually. Its matrix probes only these canonical pairs:

| Environment | Base URL |
| --- | --- |
| staging | `https://staging.firelight.ie` |
| production | `https://firelight.ie` |

For both `/api/health` and `/api/readiness`, the probe requires HTTP 200,
`application/json`, no redirect, a response no larger than 16 KiB, and an exact
envelope with no extra fields. Health must report `status: "ok"`; readiness must
report `status: "ready"`; both must report the expected environment and the same
40-character lowercase commit SHA in `buildId`. Each request has a 10-second
deadline. The complete pair is retried once after 15 seconds. Logs contain only
the environment and accepted build SHA on success, or a fixed error code on
failure. The workflow supplies no application or environment secrets, persists
no checkout credential, and attaches no protected GitHub environment.

Run either public probe locally with Node 22 or later:

```sh
FIRELIGHT_EXPECTED_ENVIRONMENT=staging \
FIRELIGHT_BASE_URL=https://staging.firelight.ie \
node scripts/public-status-probe.mjs

FIRELIGHT_EXPECTED_ENVIRONMENT=production \
FIRELIGHT_BASE_URL=https://firelight.ie \
node scripts/public-status-probe.mjs
```

A scheduled GitHub workflow can be delayed by the platform, so it is a release
and external-availability signal, not the sole paging path. Route repeated
workflow failures through the approved incident system without adding secrets
to this workflow.

## Incident use

Start with the alarm name and the `${service_name}-operations` dashboard, then
correlate rather than raising the fixed time or concurrency bounds.

| Signal | First checks |
| --- | --- |
| Function URL 5xx or Lambda errors | Gateway logs, live alias/version, internal ALB response, and recent deploy digest |
| Throttles | Reserved concurrency, request burst, ECS running/healthy capacity, and Worker retry behavior |
| Gateway duration | ALB target latency, compiler deadline events, task CPU/memory, and the exact lesson sketch involved without logging its source |
| Running task loss | ECS service events, stopped-task reason, ECR/VPC endpoint health, and desired count |
| CPU or memory pressure | Per-task utilization, compile rate, replacements, and image/task-definition change history |
| Unhealthy target or connection errors | Target health reason, task listener, ALB/task security groups, and deployment drain state |
| Target 5xx | Internal compiler logs and stable error codes; never copy raw source or unsanitized diagnostics into the incident |
| Public probe | Both status routes, environment/build identity, DNS/TLS, and the matching deployment record |

If a release caused the incident, restore the last reviewed image digest and
task definition through Terraform. Do not add a NAT route, public task address,
test endpoint, broader security-group rule, longer public deadline, or secret to
the probe as a workaround. Preserve only redacted logs and AWS audit metadata.

## Hosted acceptance checklist

Perform fault injection only in staging during an approved window. Production
acceptance is limited to non-mutating status probes, direct synthetic
notification delivery, and review of real alarm history.

1. Apply the reviewed Terraform in the intended environment and confirm the
   dashboard, 11 alarms, KMS key, topic, and the two non-sensitive outputs.
2. Connect named primary and backup recipients outside Terraform; confirm both
   subscriptions and the direct synthetic message above.
3. In staging, select one alarm and use `aws cloudwatch set-alarm-state` to move
   it to `ALARM`, then `OK`, with a content-free reason. Wait for both primary
   and backup delivery confirmations before the `OK` transition. Confirm both
   recovery deliveries and allow normal metric evaluation to resume. This
   checks alarm actions but not metric ingestion.
4. In a separate approved staging drill, create a real condition using existing
   AWS service controls, not an application test hook. Confirm the expected
   metric dimensions, threshold, dashboard series, `ALARM`, notification,
   remediation, `OK`, and recovery notification. Restore Terraform convergence
   immediately afterward.
5. Manually run the public-probe workflow. Confirm staging and production both
   accept one identical health/readiness build SHA per environment and that the
   job contains no application or environment secrets and persists no checkout
   credential.
6. Retain UTC times, alarm history, SNS message IDs, recipient confirmations,
   dashboard evidence, the probe workflow URL, deployed commit SHA, and the
   reviewer. Do not retain endpoint addresses, source, artifacts, or tokens.

Example synthetic state drill (staging only):

```sh
COMPILER_ALARM_NAME="firelight-compiler-gateway-url-5xx"
aws cloudwatch set-alarm-state \
  --region eu-west-1 \
  --alarm-name "$COMPILER_ALARM_NAME" \
  --state-value ALARM \
  --state-reason "Approved staging notification drill; no customer data."
# Wait for both ALARM delivery confirmations before continuing.
aws cloudwatch set-alarm-state \
  --region eu-west-1 \
  --alarm-name "$COMPILER_ALARM_NAME" \
  --state-value OK \
  --state-reason "Approved staging notification drill recovery."
```

## Repository and image gates

Run the local definitions without contacting AWS:

```sh
node --test scripts/public-status-probe.test.mjs scripts/export-lesson-sketches.test.mjs
python3 -m unittest discover -s compiler-service/tests -p 'test_*.py' -v

cd compiler-service/terraform
terraform fmt -check -recursive
terraform init -backend=false -input=false
terraform validate
terraform test
```

The compiler CI job must install the repository Node dependencies before the
export. It then exports the real typed catalog, builds the exact linux/amd64
image, mounts the immutable fixture read-only, and runs the verifier inside the
image under production-shaped restrictions:

```sh
FIRELIGHT_LESSON_FIXTURES="${RUNNER_TEMP}/firelight-lesson-sketches"
node scripts/export-lesson-sketches.mjs "$FIRELIGHT_LESSON_FIXTURES"

docker build \
  --platform linux/amd64 \
  --tag firelight-compiler:ci \
  compiler-service

docker run --rm \
  --platform linux/amd64 \
  --network none \
  --user 1000:1000 \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --pids-limit 128 \
  --memory 2g \
  --cpus 1 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=536870912,mode=1777 \
  --mount "type=bind,src=${FIRELIGHT_LESSON_FIXTURES},dst=/fixtures,readonly" \
  --entrypoint /var/lang/bin/python3 \
  firelight-compiler:ci \
  /var/task/verify_lesson_sketches.py --root /fixtures
```

The exporter refuses a pre-existing output directory and binds each of the six
ordered lesson IDs, versions, paths, and source hashes into the manifest. The
container-side verifier independently enforces that manifest, reads and hashes
all six sources, checks the actual Arduino CLI `1.5.1`, installed
`arduino:avr@1.8.6` core files, and Servo `1.3.0` AVR metadata/sources, then calls
the production compiler exactly once per sketch. The production command fixes
`--fqbn arduino:avr:nano:cpu=atmega328old` and
`--libraries /opt/arduino/libraries`; every artifact must bind back to its
source hash and the fixed target.
