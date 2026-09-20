# Montana Mesonet Photo Explorer — map geometry
#
# Builds docs/grid.geojson, the cell geometry the explorer draws Montana with,
# and the explorer's only static input. Station status, grid-cell assignments,
# and photo availability are all read live from the Mesonet API when the page
# loads, so stations appear and disappear on their own. Re-run this script only
# when the underlying grid definition changes — never just to add a station.

library(tidyverse)
library(sf)

# Custom Albers parameterization from Alex Stum, 2021-10-20
umrb_grid_proj <-
  list(proj = "aea",
       lat_0 = 41.8865,
       lat_1 = 43.0,
       lat_2 = 47.8,
       lon_0 = -104.0487,
       units = "mi") %>%
  {paste0("+",names(.),"=",., collapse = " ")} %>%
  sf::st_crs()

edge <-
  sqrt(500)

# The Upper Missouri River Basin planning grid in the custom Albers projection
# above: a regular grid clipped to Montana, with each cell tagged by its ID
# (`cell`) from the planning shapefile. Cells with no planned site stay
# unlabeled (`cell` = NA).
mt_grid <-
  raster::raster(crs = umrb_grid_proj$input,
                 resolution = c(edge,edge),
                 xmn = 0-(25*edge),
                 ymn = 0,
                 xmx = (19*edge),
                 ymx = 0+(24*edge)
  ) %>%
  raster::rasterToPolygons() %>%
  sf::st_as_sf() %>%
  sf::st_filter(
    mcor::mt_state_simple |>
      sf::st_transform(umrb_grid_proj)
  ) |>
  sf::st_join(sf::read_sf("data/fwmesonetgrid19oct2021") %>%
                sf::st_transform(umrb_grid_proj) %>%
                dplyr::filter(Status != "Less than 40%") %>%
                sf::st_centroid(),
              join = sf::st_contains) %>%
  dplyr::select(cell)

# Write the whole grid. Labeled cells (`cell` = "A-12", …) are the planning
# sites the explorer snaps stations onto via the API's `ace_grid` field.
# Unlabeled cells (western Montana, outside the planned grid) carry no site but
# are kept so the explorer can still place off-grid camera stations (e.g. CSKT
# Bison Range, Lubrecht HQ) in the cell that contains them. The explorer only
# draws cells with an active station, so unlabeled cells add no visual noise.
grid_sf <-
  mt_grid %>%
  sf::st_transform("EPSG:4326")

sf::write_sf(grid_sf, "docs/grid.geojson", delete_dsn = TRUE)
