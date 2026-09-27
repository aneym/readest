package com.bilingify.readest

import android.content.Context
import android.net.Uri

/** Only aggregate sync metadata crosses the WebView/native boundary. */
object HouseholdSyncStatus {
    const val AUTHORITY = "com.bilingify.readest.household"
    val URI: Uri get() = Uri.parse("content://$AUTHORITY/sync-status")
    private const val PREFS = "household_sync_status"
    private val states = setOf("idle", "syncing", "offline", "error", "unpaired")

    data class Status(
        val pending: Int,
        val lastSyncAt: Long,
        val state: String,
        val updatedAt: Long,
    )

    // The bridge accepts exactly the flat, numeric/string wire contract, without
    // interpreting arbitrary objects supplied by WebView JavaScript.
    fun parse(json: String): Status? {
        val text = json.trim()
        if (!text.startsWith('{') || !text.endsWith('}')) return null
        val entries = mutableMapOf<String, String>()
        val body = text.substring(1, text.length - 1)
        val entry = Regex("""\s*"([a-z_]+)"\s*:\s*("[a-z]+"|-?(?:0|[1-9][0-9]*))\s*""")
        var position = 0
        while (position < body.length) {
            val match = entry.find(body, position) ?: return null
            if (match.range.first != position) return null
            val (key, value) = match.destructured
            if (entries.put(key, value) != null) return null
            position = match.range.last + 1
            if (position == body.length) break
            if (body[position] != ',') return null
            position++
            if (position == body.length) return null
        }
        if (entries.keys != setOf("pending", "last_sync_at", "state", "updated_at")) return null
        val pending = entries["pending"]?.toIntOrNull()?.takeIf { it >= 0 } ?: return null
        val lastSyncAt = entries["last_sync_at"]?.toLongOrNull() ?: return null
        val updatedAt = entries["updated_at"]?.toLongOrNull() ?: return null
        val state = entries["state"]?.removeSurrounding("\"")?.takeIf { it in states } ?: return null
        // The quoted number "123" cannot be treated as a numeric field.
        if (entries["pending"]!!.startsWith('"') || entries["last_sync_at"]!!.startsWith('"') ||
            entries["updated_at"]!!.startsWith('"')) return null
        return Status(pending, lastSyncAt, state, updatedAt)
    }

    fun read(context: Context): Status {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return Status(
            prefs.getInt("pending", 0),
            prefs.getLong("last_sync_at", 0L),
            prefs.getString("state", "unpaired") ?: "unpaired",
            prefs.getLong("updated_at", 0L),
        )
    }

    fun write(context: Context, status: Status) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putInt("pending", status.pending)
            .putLong("last_sync_at", status.lastSyncAt)
            .putString("state", status.state)
            .putLong("updated_at", status.updatedAt)
            .commit()
        context.contentResolver.notifyChange(URI, null)
    }
}
