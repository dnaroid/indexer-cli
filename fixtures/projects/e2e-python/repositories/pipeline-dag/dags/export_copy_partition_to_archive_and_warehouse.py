from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from airflow.decorators import dag, task
from airflow.exceptions import AirflowSkipException

from common.alerting import on_failure_alert
from common.archive import read_json, write_json
from common.variables import get_variable as _get_variable, truthy as _truthy
from common.warehouse import copy_json_stage_to_table
from common.workflow_paths import build_destination_prefix, build_source_prefix_root


LOG = logging.getLogger(__name__)


def _parse_partition(prefix: str, root: str) -> Optional[str]:
    if not prefix.startswith(root):
        return None
    rest = prefix[len(root) :].strip("/")
    if not rest:
        return None
    return rest.split("/")[0]


@dag(
    dag_id="export_copy_partition_to_archive_and_warehouse",
    schedule=None,
    start_date=datetime(2025, 1, 1),
    catchup=False,
    default_args={
        "on_failure_callback": on_failure_alert,
    },
    tags=["exports", "archive", "warehouse"],
)
def export_copy_partition_to_archive_and_warehouse() -> None:
    @task
    def pick_next_partition() -> Dict[str, Any]:
        legacy_aws_conn_id = (
            _get_variable("export_aws_conn_id", "aws_default") or "aws_default"
        )
        source_aws_conn_id = (
            _get_variable("export_source_aws_conn_id", legacy_aws_conn_id)
            or legacy_aws_conn_id
        )
        destination_aws_conn_id = (
            _get_variable("export_destination_aws_conn_id", legacy_aws_conn_id)
            or legacy_aws_conn_id
        )

        source_bucket = _get_variable("export_source_bucket", None)
        account_id = _get_variable("export_account_id", None)
        api_version = _get_variable("export_api_version", None)
        feed = _get_variable("export_feed", "Modified") or "Modified"

        if not source_bucket or not account_id or not api_version:
            raise AirflowSkipException(
                "Source export not configured. Set Variables 'export_source_bucket', 'export_account_id', and "
                "'export_api_version'."
            )

        root_prefix = _get_variable(
            "export_source_prefix_root",
            build_source_prefix_root(
                account_id=account_id,
                feed=feed,
                api_version=api_version,
            ),
        )
        if not root_prefix:
            raise ValueError(
                "Airflow Variable 'export_source_prefix_root' resolved to empty"
            )

        destination_bucket = _get_variable("archive_bucket", None)
        destination_base_prefix = (
            _get_variable("export_archive_base_prefix", "raw/exports") or "raw/exports"
        )
        if not destination_bucket:
            raise AirflowSkipException(
                "Archive destination not configured. Set Variable 'archive_bucket'."
            )

        cursor_uri = _get_variable(
            "export_cursor_uri",
            f"s3://{destination_bucket}/{destination_base_prefix.strip('/')}/cursor.json",
        )
        if not cursor_uri:
            raise ValueError("Airflow Variable 'export_cursor_uri' resolved to empty")

        last_processed = None
        try:
            cursor = read_json(cursor_uri, conn_id=destination_aws_conn_id)
            if isinstance(cursor, dict):
                last_processed = cursor.get("last_partition")
        except FileNotFoundError:
            LOG.info(
                "No cursor found at %s; starting from earliest partition",
                cursor_uri,
            )
            last_processed = None
        except Exception:
            LOG.exception("Failed reading cursor at %s", cursor_uri)
            raise

        from airflow.providers.amazon.aws.hooks.s3 import S3Hook  # type: ignore

        hook = S3Hook(aws_conn_id=source_aws_conn_id)
        client = hook.get_conn()

        prefixes: List[str] = []
        paginator = client.get_paginator("list_objects_v2")
        for page in paginator.paginate(
            Bucket=source_bucket,
            Prefix=root_prefix,
            Delimiter="/",
        ):
            prefixes.extend(
                p["Prefix"] for p in page.get("CommonPrefixes", []) if "Prefix" in p
            )
        partitions: List[str] = []
        for prefix in prefixes:
            partition = _parse_partition(prefix, root_prefix)
            if partition:
                partitions.append(partition)
        partitions = sorted(set(partitions))

        if not partitions:
            raise AirflowSkipException(
                f"No partitions found under s3://{source_bucket}/{root_prefix}"
            )

        candidates = (
            [p for p in partitions if p > str(last_processed)]
            if last_processed
            else partitions
        )

        if not candidates:
            raise AirflowSkipException("No new partitions to process")

        chosen = candidates[0]
        return {
            "source_aws_conn_id": source_aws_conn_id,
            "destination_aws_conn_id": destination_aws_conn_id,
            "source_bucket": source_bucket,
            "root_prefix": root_prefix,
            "feed": feed,
            "api_version": api_version,
            "partition": chosen,
            "destination_bucket": destination_bucket,
            "destination_base_prefix": destination_base_prefix,
            "cursor_uri": cursor_uri,
        }

    @task
    def copy_partition_to_archive(cfg: Dict[str, Any]) -> Dict[str, Any]:
        source_aws_conn_id = cfg["source_aws_conn_id"]
        destination_aws_conn_id = cfg["destination_aws_conn_id"]
        source_bucket = cfg["source_bucket"]
        root_prefix = cfg["root_prefix"].rstrip("/")
        feed = cfg["feed"]
        api_version = cfg["api_version"]
        partition = cfg["partition"]
        destination_bucket = cfg["destination_bucket"]
        destination_base_prefix = cfg["destination_base_prefix"]

        from airflow.providers.amazon.aws.hooks.s3 import S3Hook  # type: ignore

        source_hook = S3Hook(aws_conn_id=source_aws_conn_id)
        destination_hook = S3Hook(aws_conn_id=destination_aws_conn_id)

        partition_prefix = f"{root_prefix}/{partition}/"
        keys = source_hook.list_keys(
            bucket_name=source_bucket,
            prefix=partition_prefix,
        )
        if not keys:
            raise AirflowSkipException(
                f"No objects found under s3://{source_bucket}/{partition_prefix}"
            )

        destination_prefix = build_destination_prefix(
            base_prefix=destination_base_prefix,
            feed=feed,
            api_version=api_version,
            job_export_time=partition,
        )

        copied = 0
        sample: List[str] = []
        for key in keys:
            relative_key = key[len(partition_prefix) :]
            destination_key = f"{destination_prefix}{relative_key}"

            try:
                destination_hook.copy_object(
                    source_bucket_key=key,
                    dest_bucket_key=destination_key,
                    source_bucket_name=source_bucket,
                    dest_bucket_name=destination_bucket,
                )
            except Exception as error:
                LOG.warning(
                    "Server-side copy failed for s3://%s/%s -> s3://%s/%s (%s); falling back to streaming copy",
                    source_bucket,
                    key,
                    destination_bucket,
                    destination_key,
                    type(error).__name__,
                )
                source_client = source_hook.get_conn()
                destination_client = destination_hook.get_conn()
                response = source_client.get_object(Bucket=source_bucket, Key=key)
                body = response["Body"]
                try:
                    destination_client.upload_fileobj(
                        body,
                        destination_bucket,
                        destination_key,
                    )
                finally:
                    try:
                        body.close()
                    except Exception:
                        pass

            copied += 1
            if len(sample) < 25:
                sample.append(destination_key)

        manifest_uri = f"s3://{destination_bucket}/{destination_prefix}manifest.json"
        write_json(
            manifest_uri,
            {
                "source": {"bucket": source_bucket, "prefix": partition_prefix},
                "destination": {
                    "bucket": destination_bucket,
                    "prefix": destination_prefix,
                },
                "feed": feed,
                "api_version": api_version,
                "partition": partition,
                "copied_objects": copied,
                "sample_dest_keys": sample,
                "generated_at": datetime.utcnow().strftime("%Y%m%dT%H%M%SZ"),
            },
            conn_id=destination_aws_conn_id,
        )

        return {
            **cfg,
            "destination_prefix": destination_prefix,
            "manifest_uri": manifest_uri,
            "copied_objects": copied,
        }

    @task
    def maybe_copy_into_warehouse(cfg: Dict[str, Any]) -> Dict[str, Any]:
        enabled = _truthy(_get_variable("export_enable_warehouse_load", "false"))
        if not enabled:
            raise AirflowSkipException(
                "Warehouse load disabled. Set Variable 'export_enable_warehouse_load' to true to enable."
            )

        warehouse_conn_id = _get_variable("export_warehouse_conn_id", None)
        target_table = _get_variable("export_warehouse_target_table", None)
        stage_base = _get_variable("export_warehouse_stage_base", None)
        if not warehouse_conn_id or not target_table or not stage_base:
            raise AirflowSkipException(
                "Warehouse load not configured. Set Variables 'export_warehouse_conn_id', "
                "'export_warehouse_target_table', and 'export_warehouse_stage_base'."
            )

        destination_prefix = cfg["destination_prefix"].strip("/")
        stage_path = f"{stage_base.rstrip('/')}/{destination_prefix}"

        strip_outer_array = _truthy(_get_variable("export_strip_outer_array", "false"))

        try:
            copy_json_stage_to_table(
                warehouse_conn_id=warehouse_conn_id,
                table=target_table,
                stage_path=stage_path,
                strip_outer_array=strip_outer_array,
            )
        except ImportError as error:
            raise AirflowSkipException(f"Warehouse provider not available: {error}")

        return {
            **cfg,
            "warehouse": {
                "conn_id": warehouse_conn_id,
                "table": target_table,
                "stage_path": stage_path,
            },
        }

    @task
    def update_cursor(cfg: Dict[str, Any]) -> None:
        destination_aws_conn_id = cfg["destination_aws_conn_id"]
        cursor_uri = cfg["cursor_uri"]
        write_json(
            cursor_uri,
            {
                "last_partition": cfg["partition"],
                "updated_at": datetime.utcnow().strftime("%Y%m%dT%H%M%SZ"),
                "last_manifest_uri": cfg.get("manifest_uri"),
                "last_copied_objects": cfg.get("copied_objects"),
            },
            conn_id=destination_aws_conn_id,
        )

    cfg = pick_next_partition()
    copied_cfg = copy_partition_to_archive(cfg)
    maybe_copy_into_warehouse(copied_cfg)
    update_cursor(copied_cfg)


export_copy_partition_to_archive_and_warehouse()
