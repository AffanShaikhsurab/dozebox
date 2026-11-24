# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub's private vulnerability reporting on this repository
("Security" tab, "Report a vulnerability"). Do not open a public issue.

Include what you found, how to reproduce it, and the version or commit. We aim to acknowledge a report within
3 working days and to agree a disclosure date with you.

## Supported versions

| Version                           | Supported                                                |
| --------------------------------- | -------------------------------------------------------- |
| Latest minor of the current major | Fixes and security fixes                                 |
| Previous major                    | Security fixes for 12 months after the next major's `.0` |
| Pre-1.0                           | Only the latest release                                  |

## Scope

In scope: the box agent, the control function, the CLI, the Terraform module and the protocol packages. Out of
scope: payloads you run on a box, and misconfiguration of your own AWS account.
