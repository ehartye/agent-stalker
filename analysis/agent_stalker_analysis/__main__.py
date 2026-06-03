import argparse
import json
import sys

from .check import check


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="agent_stalker_analysis")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("check")
    run_p = sub.add_parser("run")
    run_p.add_argument("--features", default="sentiment,topics,errors,pivots")
    run_p.add_argument("--db", default=None)
    args = parser.parse_args(argv)

    if args.command == "check":
        print(json.dumps(check()))
        return 0
    if args.command == "run":
        from .run import run
        result = run(args.features.split(","), args.db)
        print(json.dumps(result))
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
