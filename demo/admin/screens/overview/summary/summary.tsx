export default function Summary({ api }) {
  const customers = useTable(api, 'customers', { pp: 1 })
  const orders = useTable(api, 'orders', { pp: 8, sort: '-placed_at' })
  return (
    <Page title="Overview" sub="A scripted page — live data from your tables through the sx SDK, no backend code.">
      <Tiles items={[
        { label: 'Customers', value: fmt.num(customers.total) },
        { label: 'Recent orders', value: fmt.num(orders.total) },
      ]} />
      <Section title="Latest orders" />
      <AdminTable api={api} slug="orders" pp={8} sort="-placed_at" cap={8} />
    </Page>
  )
}
