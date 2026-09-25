export async function completeOlderOrders(client, now = new Date()) {
    const cutoff = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();
    // Filter in the update itself: include all pages and recheck current status.
    const { error, count } = await client.from('orders')
        .update({ status: 'completed', completed_at: now.toISOString() }, { count: 'exact' })
        .in('status', ['paid', 'shipped'])
        .lte('created_at', cutoff);
    if (error) throw error;
    return count;
}
