# Firelight compiler service

This directory owns the private Arduino compiler Lambda. It accepts one board
target (`arduino:avr:nano:cpu=atmega328old`), compiles a bounded sketch with a
pinned toolchain, and returns a validated Intel HEX artifact. It is not a public
browser API.

The implementation and tests are dependency-free Python:

```sh
python3 -m unittest discover -s compiler-service/tests -v
```

Image, infrastructure, deployment, request contract, limits, and security
instructions live in [`../docs/compiler-service.md`](../docs/compiler-service.md).

No deployment command is run by the test suite. Arduino CLI is mocked at the
process boundary, so unit tests are deterministic and need neither Docker nor a
network connection.
