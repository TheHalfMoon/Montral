// Command terraform-provider-montral is the Terraform (and OpenTofu) provider for Montral.
package main

import (
	"context"
	"flag"
	"log"

	"github.com/hashicorp/terraform-plugin-framework/providerserver"

	"github.com/TheHalfMoon/Montral/terraform-provider-montral/internal/provider"
)

// version is set by the build (-ldflags "-X main.version=..."); unpublished builds report "dev".
var version = "dev"

func main() {
	var debug bool
	flag.BoolVar(&debug, "debug", false, "run the provider with support for debuggers like delve")
	flag.Parse()
	err := providerserver.Serve(context.Background(), provider.New(version), providerserver.ServeOpts{
		Address: "registry.terraform.io/thehalfmoon/montral",
		Debug:   debug,
	})
	if err != nil {
		log.Fatal(err)
	}
}
