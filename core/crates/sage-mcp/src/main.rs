//! sage-mcp's executable: a harness starts it as a stdio MCP server, with the tool socket and its token in the environment.

fn main() {
    let env = |name: &str| std::env::var(name).ok();
    let code = sage_mcp::run(env, std::io::stdin(), std::io::stdout(), &mut std::io::stderr(), sage_mcp::Ids::current(), sage_mcp::connect);
    std::process::exit(code);
}
