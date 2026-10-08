# Fork features and maintenance

This index owns fork-specific links so upstream's documentation index can evolve independently.

- [Performance protection and recovery](./user/performance-recovery.md)
- [Moving threads between machines](./user/moving-threads.md)
- [`t3-thread` operator CLI](./architecture/t3-thread.md)
- [Mobile app](../apps/mobile/README.md) and [iOS deployment options](./mobile/ios-deployment.md)
- [Rebase the fork or resolve a patch conflict](./operations/fork-maintenance.md#rebase-and-conflict-repair)
- [Add or change a fork feature](./operations/fork-maintenance.md#adding-or-changing-fork-functionality)
- [Deploy a reviewed new concern safely](./operations/fork-maintenance.md#isolated-implementation-and-candidate-deployment)
- [Publish the StGit stack safely](./operations/fork-maintenance.md#publication)
- [Fork CI](./operations/ci.md)
- [Release](./operations/release.md)
- [Fork maintenance](./operations/fork-maintenance.md)
- [Fork patch inventory](./operations/fork-inventory/)

- [Measure update reliability](./operations/fork-maintenance.md#measure-update-reliability)

## Session reconciliation races

Session reconciliation checks causal ownership before planning and validates the
thread's event sequence again when committing. If provider work or another
thread event arrives in between, reconciliation refuses without interrupting
that work. Refresh the thread before requesting reconciliation again; reusing a
rejected command ID continues to return its recorded rejection. Ordinary Stop
acknowledgments retain their existing behavior.
