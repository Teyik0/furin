import { route as rootRoute } from "../root";

export default rootRoute.page({
  staticParams: () => [{ slug: "hello-world" }],
  component: () => <article>Blog post page</article>,
});
