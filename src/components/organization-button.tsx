
import { LogOut } from "lucide-react";
import { useRouter } from "@tanstack/react-router";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { getToken, signOut, CustomJwtPayload } from "@/lib/store";
import { useEffect, useState } from "react";

export function OrganizationButton() {
  const [organization, setOrganization] = useState<CustomJwtPayload | null>(null);
  const router = useRouter();

  useEffect(() => {
    const fetchOrganization = async () => {
      const organization = await getToken();
      setOrganization(organization);
    };
    fetchOrganization();
  }, []);

  const handleSignOut = async () => {
    await signOut();
    router.navigate({ to: "/login" });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="focus:outline-none">
          <Avatar className="h-8 w-8 rounded-full">
            <AvatarImage
              src={organization?.org_image_url}
              alt={organization?.org_name}
            />
            <AvatarFallback className="rounded-full">
              {organization?.org_name?.charAt(0)}
            </AvatarFallback>
          </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>
          {organization?.org_name}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleSignOut}>
          <LogOut className="h-4 w-4 mr-2" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
