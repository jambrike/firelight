# Firelight compiler service

This directory owns the public authenticated Lambda gateway and the network-
isolated Arduino compiler service. The gateway cannot invoke the toolchain: it
forwards a bounded request through an internal ALB to Fargate tasks in private
subnets. Tasks have no public IP, task role, application secret, or internet
route. The compiler accepts one board target
(`arduino:avr:nano:cpu=atmega328old`) and returns validated Intel HEX. Neither
surface is a public browser API.

The image pins Arduino CLI, the AVR core and all transitive tools, and the
standalone Servo 1.3.0 library required by Lesson 5. Build-time installers verify
archive hashes and metadata before any dependency enters the runtime image.

The implementation and tests are dependency-free Python:

```sh
python3 -m unittest discover -s compiler-service/tests -v
```

The one pinned image defaults to `app.gateway_lambda_handler` under Lambda. ECS
explicitly starts `python app.py serve`; invoking `app.py` without that mode
fails closed.

Image, infrastructure, deployment, request contract, limits, and security
instructions live in [`../docs/compiler-service.md`](../docs/compiler-service.md).

No deployment command is run by the test suite. Arduino CLI is mocked at the
process boundary, so unit tests are deterministic and need neither Docker nor a
network connection.
