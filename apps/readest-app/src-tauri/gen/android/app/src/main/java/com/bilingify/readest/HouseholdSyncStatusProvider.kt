package com.bilingify.readest

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri

class HouseholdSyncStatusProvider : ContentProvider() {
    override fun onCreate(): Boolean = true

    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?,
    ): Cursor {
        require(uri == HouseholdSyncStatus.URI) { "Unknown sync status URI" }
        val columns = arrayOf("pending", "last_sync_at", "state", "updated_at")
        val selected = projection ?: columns
        require(selected.all { it in columns }) { "Unknown sync status column" }
        val status = HouseholdSyncStatus.read(requireNotNull(context))
        val values: Map<String, Any> = mapOf(
            "pending" to status.pending,
            "last_sync_at" to status.lastSyncAt,
            "state" to status.state,
            "updated_at" to status.updatedAt,
        )
        return MatrixCursor(selected).apply {
            addRow(selected.map { values.getValue(it) })
            setNotificationUri(requireNotNull(context).contentResolver, HouseholdSyncStatus.URI)
        }
    }

    override fun getType(uri: Uri): String? =
        if (uri == HouseholdSyncStatus.URI) "vnd.android.cursor.item/vnd.${HouseholdSyncStatus.AUTHORITY}.sync-status" else null

    override fun insert(uri: Uri, values: ContentValues?): Uri =
        throw UnsupportedOperationException("Read-only sync status")

    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int =
        throw UnsupportedOperationException("Read-only sync status")

    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int =
        throw UnsupportedOperationException("Read-only sync status")
}
