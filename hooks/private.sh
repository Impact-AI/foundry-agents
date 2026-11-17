#!/usr/bin/env bash
# Sourced by a script that writes through a data plane from the operator's
# machine. When the service's public listener is off, the script says what
# Microsoft's guidance says — run from inside the network, or open the
# listener for the minutes it takes — instead of failing on a connection error.
#
#   refuse_private <service> <host> <the command to run again inside> <the command that opens the listener for its run>

refuse_private() {
	cat >&2 <<EOF

$1 at $2 has its public listener off and is not reachable from here. Either:

  * run this from inside the virtual network — the jump VM that DEVELOPER_ACCESS=true adds,
    through Azure Bastion, or any host whose DNS resolves the private endpoint — signed in
    with az and azd there:
      $3

  * or let the script open the listener for its run and close it again when the run ends,
    however it ends:
      $4
EOF
	exit 1
}
